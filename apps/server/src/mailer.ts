import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { randomBytes } from "node:crypto";

/**
 * Sending mail, over SMTP, without a dependency.
 *
 * **Why this is hand written.** The server has two runtime dependencies, `express` and `cors`,
 * in a product whose selling point is that it holds your schema and your credentials. Nodemailer
 * would pull a tree into that, and SMTP is a line protocol that Node's own `net` and `tls` speak
 * directly. This file is the whole client. The same reasoning produced the tar writer in
 * `archive.ts`.
 *
 * **Mail is optional and stays optional.** An invitation is a link; email is one way to hand it
 * over. Requiring a working mail server before anybody can add a second user is a common reason a
 * self-hosted install stalls, so nothing here runs unless an operator configures it, and a
 * failure to send never fails the thing that produced the message.
 */

export interface SmtpConfig {
  host: string;
  port: number;
  /** Optional: plenty of internal relays accept mail from the local network unauthenticated. */
  username?: string;
  password?: string;
  /** The envelope sender. Must be an address the provider lets you send as. */
  from: string;
  /** Display name on the From header. */
  fromName?: string;
  /**
   * `auto` picks implicit TLS on 465 and STARTTLS elsewhere, which is what almost everyone wants.
   * `none` exists for a relay on localhost and is refused for anything else.
   */
  security?: "auto" | "tls" | "starttls" | "none";
}

export interface Message {
  to: string;
  subject: string;
  text: string;
}

export class MailError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
    this.name = "MailError";
  }
}

/** Ten seconds per step. A mail server that is slower than this is not going to recover. */
const STEP_TIMEOUT_MS = 10_000;

/**
 * Addresses and header values, checked for CR and LF.
 *
 * **This is header injection, and it is the one genuinely dangerous input here.** A newline in a
 * subject or a recipient lets the caller write their own headers, which turns "invite this
 * person" into "and blind copy these thousand others". Rejected rather than stripped, because a
 * silently altered address is a support ticket nobody can reproduce.
 */
function assertHeaderSafe(value: string, field: string): string {
  // The control characters are the point: CR, LF and NUL are exactly what a header
  // injection attempt smuggles in, so the rule that objects to them is inverted here.
  // oxlint-disable-next-line no-control-regex
  if (/[\r\n\0]/.test(value)) {
    throw new MailError(`the ${field} must not contain line breaks`, 422);
  }
  return value;
}

/** Not validation, just enough to catch the paste that obviously is not an address. */
/*
  The domain is matched label by label, and the labels exclude the dot.

  The previous shape was `[^\s@,;<>]+\.[^\s@,;<>]+`, where both sides of the literal dot could
  themselves match dots. That leaves the engine a choice about where the separator goes, so a
  non-matching address costs quadratic backtracking rather than a linear scan. Excluding `.` from
  the label class removes the choice entirely: there is exactly one way to split `example.com`.

  It is also stricter in the two places that matter, and both are improvements. `a@b..com` and
  `a@b.com.` used to pass, because a label was allowed to absorb the extra dot.
*/
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@,;<>]+@[^\s@,;<>.]+(?:\.[^\s@,;<>.]+)+$/.test(value.trim());
}

// ---------------------------------------------------------------- the conversation

/**
 * One SMTP exchange, from greeting to QUIT.
 *
 * Deliberately a function rather than a pooled client. Strata sends a handful of messages a day
 * at most, and a connection held open between them is a thing to keep alive, notice the death of,
 * and reconnect: all cost, no benefit, at this volume.
 */
class Session {
  private buffer = "";
  private socket: Socket | TLSSocket;

  private constructor(socket: Socket | TLSSocket) {
    this.socket = socket;
    this.socket.setEncoding("utf8");
  }

  static async open(config: SmtpConfig): Promise<Session> {
    const implicit = (config.security ?? "auto") === "tls" ||
      ((config.security ?? "auto") === "auto" && config.port === 465);

    const socket = await new Promise<Socket | TLSSocket>((resolve, reject) => {
      const onError = (error: Error): void => reject(new MailError(reason(error), 502));
      const options = { host: config.host, port: config.port };

      const s = implicit
        ? tlsConnect({ ...options, servername: config.host }, () => resolve(s))
        : netConnect(options, () => resolve(s));

      s.once("error", onError);
      s.setTimeout(STEP_TIMEOUT_MS, () => {
        s.destroy();
        reject(new MailError(`${config.host}:${config.port} did not answer`, 504));
      });
    });

    return new Session(socket);
  }

  /**
   * Read one complete reply.
   *
   * SMTP replies can span lines: a continuation is `250-TEXT` and the last line is `250 TEXT`.
   * Reading a single line would treat the first capability of an EHLO response as the whole
   * answer and leave the rest in the buffer to confuse the next step.
   */
  async read(): Promise<{ code: number; text: string }> {
    for (;;) {
      /*
        Scanned line by line rather than with one regex over the whole reply.

        Every line repeats the code, and the separator marks the end: `250-TEXT` continues,
        `250 TEXT` finishes. Expressing that in a single pattern needs a backreference to "the
        same three digits again", which is where the first version of this went wrong. It matched
        one continuation line and then failed, so an EHLO reply never looked complete and the read
        sat waiting for bytes that had already arrived.
      */
      const lines = this.buffer.split(/\r?\n/);

      for (let i = 0; i < lines.length; i += 1) {
        const match = /^(\d{3})([ -])/.exec(lines[i] ?? "");
        if (!match || match[2] !== " ") continue;

        const consumed = lines.slice(0, i + 1);
        this.buffer = this.buffer
          .slice(consumed.join("\r\n").length)
          .replace(/^\r?\n/, "");
        return { code: Number(match[1]), text: consumed.join("\n").trim() };
      }

      this.buffer += await this.chunk();
    }
  }

  private chunk(): Promise<string> {
    return new Promise((resolve, reject) => {
      const onData = (data: string): void => {
        cleanup();
        resolve(data);
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(new MailError(reason(error), 502));
      };
      const onClose = (): void => {
        cleanup();
        reject(new MailError("the mail server closed the connection", 502));
      };
      const onTimeout = (): void => {
        cleanup();
        this.socket.destroy();
        reject(new MailError("the mail server stopped responding", 504));
      };
      const cleanup = (): void => {
        this.socket.off("data", onData);
        this.socket.off("error", onError);
        this.socket.off("close", onClose);
        this.socket.off("timeout", onTimeout);
      };

      this.socket.on("data", onData);
      this.socket.once("error", onError);
      this.socket.once("close", onClose);
      this.socket.once("timeout", onTimeout);
    });
  }

  write(line: string): void {
    this.socket.write(`${line}\r\n`);
  }

  /**
   * Send a command and require a reply in the expected class.
   *
   * `secret` keeps a credential out of the error message. An SMTP failure is reported to an
   * admin and written to the log, and "AUTH failed for <base64 password>" is exactly the sort of
   * helpful diagnostic that ends up in a support thread.
   */
  async command(line: string, expect: number, secret = false): Promise<{ code: number; text: string }> {
    this.write(line);
    const reply = await this.read();
    if (Math.floor(reply.code / 100) !== Math.floor(expect / 100)) {
      throw new MailError(
        secret ? `the mail server refused the credentials (${reply.code})` : `${reply.text}`,
        502,
      );
    }
    return reply;
  }

  async upgrade(host: string): Promise<void> {
    const plain = this.socket as Socket;
    this.socket = await new Promise<TLSSocket>((resolve, reject) => {
      const secure = tlsConnect({ socket: plain, servername: host }, () => resolve(secure));
      secure.once("error", (error) => reject(new MailError(reason(error), 502)));
    });
    this.socket.setEncoding("utf8");
    this.buffer = "";
  }

  /**
   * Say goodbye properly.
   *
   * `end()` rather than `write()` then `destroy()`. Destroying discards anything still in the
   * write buffer, so the QUIT was frequently never sent and the server saw an aborted connection
   * instead of a clean close. Some mail servers log that as a failure, and a few count it against
   * the sender's reputation, which for a host that sends five messages a week is not free.
   */
  end(): void {
    try {
      this.socket.end("QUIT\r\n");
    } catch {
      // Already gone. The message was accepted or it was not, and QUIT changes neither.
      this.socket.destroy();
    }
  }
}

/** Node's socket errors are terse and leak paths. This keeps what an operator can act on. */
function reason(error: Error): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOTFOUND") return "that host does not resolve";
  if (code === "ECONNREFUSED") return "the connection was refused, check the port";
  if (code === "ETIMEDOUT") return "the connection timed out";
  if (code === "CERT_HAS_EXPIRED") return "the mail server's TLS certificate has expired";
  if (code?.startsWith("ERR_TLS") || code === "EPROTO") return "TLS negotiation failed, check the port and security setting";
  return error.message;
}

// ---------------------------------------------------------------- sending

export async function sendMail(config: SmtpConfig, message: Message): Promise<void> {
  const from = assertHeaderSafe(config.from.trim(), "from address");
  const to = assertHeaderSafe(message.to.trim(), "recipient");
  const subject = assertHeaderSafe(message.subject, "subject");

  if (!looksLikeEmail(to)) throw new MailError(`\`${to}\` is not an email address`, 422);
  if (!looksLikeEmail(from)) throw new MailError(`\`${from}\` is not an email address`, 422);

  const security = config.security ?? "auto";
  const session = await Session.open(config);

  try {
    await session.read(); // greeting

    const ehlo = await session.command(`EHLO ${hostname(from)}`, 250);

    const wantsStarttls =
      security === "starttls" || (security === "auto" && config.port !== 465);

    if (wantsStarttls) {
      if (!/STARTTLS/i.test(ehlo.text)) {
        throw new MailError(
          "the mail server does not offer STARTTLS. Use port 465, or set security to none only " +
            "if it is on localhost.",
          502,
        );
      }
      await session.command("STARTTLS", 220);
      await session.upgrade(config.host);
      // Capabilities are re-read after the upgrade: a server may advertise AUTH only once the
      // connection is encrypted, which is the correct thing for it to do.
      await session.command(`EHLO ${hostname(from)}`, 250);
    }

    if (config.username && config.password) {
      await session.command("AUTH LOGIN", 334, true);
      await session.command(Buffer.from(config.username, "utf8").toString("base64"), 334, true);
      await session.command(Buffer.from(config.password, "utf8").toString("base64"), 235, true);
    }

    await session.command(`MAIL FROM:<${from}>`, 250);
    await session.command(`RCPT TO:<${to}>`, 250);
    await session.command("DATA", 354);

    session.write(render({ ...config, from }, { ...message, to, subject }));
    session.write(".");

    const accepted = await session.read();
    if (Math.floor(accepted.code / 100) !== 2) {
      throw new MailError(`the mail server rejected the message: ${accepted.text}`, 502);
    }
  } finally {
    session.end();
  }
}

/** The part after the `@`, used to identify ourselves in EHLO. */
function hostname(from: string): string {
  return from.split("@")[1] ?? "localhost";
}

/**
 * The message, as RFC 5322 text.
 *
 * Plain text, not HTML, and that is a choice rather than laziness. A plain message renders
 * identically everywhere, cannot be broken by a mail client's CSS handling, and is less likely to
 * be scored as marketing by a spam filter. The only thing this email has to do is carry a link
 * that works.
 */
function render(config: SmtpConfig, message: Message): string {
  const from = config.fromName
    ? `${quoted(config.fromName)} <${config.from}>`
    : config.from;

  const headers = [
    `From: ${from}`,
    `To: ${message.to}`,
    `Subject: ${message.subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomBytes(12).toString("hex")}@${hostname(config.from)}>`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: 8bit",
    // Invitations are transactional. Without this, a vacation responder can reply to every one.
    "Auto-Submitted: auto-generated",
  ];

  return `${headers.join("\r\n")}\r\n\r\n${stuff(message.text)}`;
}

/** A display name with a comma or a quote in it has to be quoted, or it splits the header. */
function quoted(name: string): string {
  return `"${assertHeaderSafe(name, "sender name").replace(/["\\]/g, "\\$&")}"`;
}

/**
 * Dot stuffing, and CRLF line endings.
 *
 * A lone `.` on its own line ends the DATA block. A message body containing one would be
 * truncated there, and the remainder interpreted as SMTP commands. Doubling the leading dot is
 * how the protocol says to escape it.
 */
function stuff(text: string): string {
  return text
    .replace(/\r?\n/g, "\r\n")
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

// ---------------------------------------------------------------- the invitation email

/**
 * What each role can actually do, in one line the recipient reads before clicking.
 *
 * Keyed by the role string rather than the `Role` type, because this module is deliberately free
 * of imports from `auth.ts`: the mailer is a socket and a string builder, and an unrecognised
 * role simply omits the line rather than failing to send the invitation.
 */
const ROLE_SUMMARY: Record<string, string> = {
  viewer: "As a viewer you can read every model, diagram and definition, and change none of them.",
  editor: "As an editor you can change models and open pull requests for review.",
  admin: "As an administrator you can also change settings, integrations and accounts.",
};

export function invitationMessage(input: {
  to: string;
  link: string;
  role: string;
  invitedBy: string;
  instance?: string;
}): Message {
  const where = input.instance ? ` to ${input.instance}` : "";

  return {
    to: input.to,
    subject: `${input.invitedBy} invited you to Strata`,
    /*
      Short on purpose. The reader has one thing to do, and burying it under an explanation of
      what Strata is would be writing for us rather than for them. The link is on its own line so
      every mail client links it.
    */
    text: [
      `${input.invitedBy} has invited you${where} as ${/^[aeiou]/i.test(input.role) ? "an" : "a"} ${input.role}.`,
      /*
        One line saying what the role can do.

        A viewer who is not told arrives at an interface where everything is greyed out and
        reports it as broken, which is the failure this whole invitation path exists to avoid:
        inviting a stakeholder as a viewer is how a model reaches the people who will never
        install strata, and their first impression should not be a dead screen. The app now says
        so too, in a banner, but the email is where they decide whether to bother clicking.
      */
      ...(ROLE_SUMMARY[input.role] ? ["", ROLE_SUMMARY[input.role]!] : []),
      "",
      "Open this link to choose a password and create your account:",
      "",
      input.link,
      "",
      "The link works once and expires in seven days.",
      "",
      "If you were not expecting this, you can ignore it. No account is created until",
      "somebody opens the link.",
    ].join("\n"),
  };
}
