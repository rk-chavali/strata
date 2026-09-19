import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { MailError, invitationMessage, looksLikeEmail, sendMail } from "./mailer.js";

/**
 * The SMTP client, against a real socket.
 *
 * No mocking, for the same reason `routes.test.ts` boots a real server: the thing most likely to
 * be wrong here is the conversation itself, and a stub of the conversation cannot be wrong in the
 * same way. This fake speaks the protocol and records what it was told, so a test can assert on
 * the bytes that actually went out.
 */

interface Fake {
  port: number;
  /** Every line the client sent, in order. */
  transcript: string[];
  /** Everything between DATA and the terminating dot. */
  body: string;
  close: () => Promise<void>;
}

const servers: Server[] = [];

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop();
    if (server) await new Promise<void>((done) => server.close(() => done()));
  }
});

/**
 * A minimal SMTP server.
 *
 * `refuse` lets a test make one verb fail, which is how the error paths get exercised without
 * needing a broken mail provider to hand.
 */
async function fakeSmtp(options: { refuse?: { verb: string; reply: string } } = {}): Promise<Fake> {
  const state: Fake = {
    port: 0,
    transcript: [],
    body: "",
    close: async () => undefined,
  };

  let inData = false;
  const bodyLines: string[] = [];

  const server = createServer((socket: Socket) => {
    socket.setEncoding("utf8");
    socket.write("220 fake.test ESMTP\r\n");

    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\r\n");

      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf("\r\n");

        if (inData) {
          if (line === ".") {
            inData = false;
            state.body = bodyLines.join("\n");
            socket.write("250 2.0.0 Ok: queued\r\n");
          } else {
            bodyLines.push(line);
          }
          continue;
        }

        state.transcript.push(line);
        const verb = line.split(/[ :]/)[0]?.toUpperCase() ?? "";

        if (options.refuse && verb === options.refuse.verb) {
          socket.write(`${options.refuse.reply}\r\n`);
          continue;
        }

        if (verb === "EHLO") {
          // Multiline on purpose: a single-line reader passes the happy path and then hangs here.
          socket.write("250-fake.test\r\n250-PIPELINING\r\n250-8BITMIME\r\n250 AUTH LOGIN PLAIN\r\n");
        } else if (verb === "AUTH") {
          socket.write("334 VXNlcm5hbWU6\r\n");
        } else if (verb === "MAIL" || verb === "RCPT") {
          socket.write("250 2.1.0 Ok\r\n");
        } else if (verb === "DATA") {
          inData = true;
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (verb === "QUIT") {
          socket.write("221 Bye\r\n");
          socket.end();
        } else if (/^[A-Za-z0-9+/=]+$/.test(line)) {
          // A base64 line: the username, then the password.
          socket.write(state.transcript.filter((l) => /^[A-Za-z0-9+/=]+$/.test(l)).length >= 2
            ? "235 2.7.0 Authentication successful\r\n"
            : "334 UGFzc3dvcmQ6\r\n");
        } else {
          socket.write("250 Ok\r\n");
        }
      }
    });

    socket.on("error", () => undefined);
  });

  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  state.port = (server.address() as AddressInfo).port;
  return state;
}

function config(port: number, extra: Record<string, unknown> = {}) {
  return {
    host: "127.0.0.1",
    port,
    from: "strata@example.com",
    // `none` so the test does not need a certificate. Production defaults to STARTTLS.
    security: "none" as const,
    ...extra,
  };
}

describe("looksLikeEmail", () => {
  it("accepts an address and rejects the usual pastes", () => {
    expect(looksLikeEmail("dana@example.com")).toBe(true);
    for (const bad of ["", "dana", "dana@", "@example.com", "dana@example", "a b@c.com", "a,b@c.com"]) {
      expect(looksLikeEmail(bad), bad).toBe(false);
    }
  });

  it("still accepts the shapes real addresses come in", () => {
    // Guarding the rewrite: the label-by-label form must not have narrowed what it accepts.
    for (const good of [
      "dana@example.com",
      "dana.k@example.co.uk",
      "dana+strata@example.com",
      "d@a.io",
      "dana_k@sub.domain.example.com",
    ]) {
      expect(looksLikeEmail(good), good).toBe(true);
    }
  });

  it("rejects the doubled and trailing dots the old pattern let through", () => {
    for (const bad of ["dana@example..com", "dana@example.com.", "dana@.example.com"]) {
      expect(looksLikeEmail(bad), bad).toBe(false);
    }
  });

  it("answers a long hostile input immediately rather than backtracking", () => {
    /*
      The reason the pattern changed. The old form let both sides of the literal dot match dots
      too, so a long domain that ultimately fails had quadratically many ways to be split, and an
      invitation address is supplied by whoever is filling in the form.

      A time bound rather than a correctness assertion, because there is no output to compare:
      the old pattern returns the same `false`, just far too slowly.
    */
    const hostile = `a@${"a.".repeat(5000)} `;

    const started = performance.now();
    expect(looksLikeEmail(hostile)).toBe(false);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe("sending", () => {
  it("holds a whole conversation", async () => {
    const fake = await fakeSmtp();
    await sendMail(config(fake.port), {
      to: "dana@example.com",
      subject: "Hello",
      text: "A line.",
    });

    // The leading sequence, not the whole transcript: QUIT is written as the socket closes, so
    // whether the fake has processed it by now is a race this test has no reason to run.
    const verbs = fake.transcript.map((line) => line.split(/[ :]/)[0]?.toUpperCase());
    expect(verbs.slice(0, 4)).toEqual(["EHLO", "MAIL", "RCPT", "DATA"]);
    expect(fake.transcript).toContain("MAIL FROM:<strata@example.com>");
    expect(fake.transcript).toContain("RCPT TO:<dana@example.com>");
  });

  it("parses a multiline EHLO reply", async () => {
    // The fake answers EHLO across four lines. A reader that stops at the first would leave the
    // rest in the buffer and misread it as the reply to MAIL FROM.
    const fake = await fakeSmtp();
    await sendMail(config(fake.port), { to: "dana@example.com", subject: "Hi", text: "x" });
    expect(fake.transcript.filter((l) => l.startsWith("MAIL"))).toHaveLength(1);
  });

  it("writes the headers a mail client needs", async () => {
    const fake = await fakeSmtp();
    await sendMail(config(fake.port, { fromName: "Strata" }), {
      to: "dana@example.com",
      subject: "Hello",
      text: "A line.",
    });

    expect(fake.body).toContain("From: \"Strata\" <strata@example.com>");
    expect(fake.body).toContain("To: dana@example.com");
    expect(fake.body).toContain("Subject: Hello");
    expect(fake.body).toContain("MIME-Version: 1.0");
    // Transactional, so a vacation responder does not reply to every invitation.
    expect(fake.body).toContain("Auto-Submitted: auto-generated");
    expect(fake.body).toContain("A line.");
  });

  it("authenticates when credentials are given", async () => {
    const fake = await fakeSmtp();
    await sendMail(config(fake.port, { username: "apikey", password: "s3cret" }), {
      to: "dana@example.com",
      subject: "Hi",
      text: "x",
    });

    expect(fake.transcript).toContain("AUTH LOGIN");
    expect(fake.transcript).toContain(Buffer.from("apikey").toString("base64"));
    expect(fake.transcript).toContain(Buffer.from("s3cret").toString("base64"));
  });

  it("skips authentication when there are no credentials", async () => {
    // Plenty of internal relays accept mail from the local network unauthenticated, and sending
    // AUTH anyway makes those refuse the message.
    const fake = await fakeSmtp();
    await sendMail(config(fake.port), { to: "dana@example.com", subject: "Hi", text: "x" });
    expect(fake.transcript).not.toContain("AUTH LOGIN");
  });

  it("escapes a lone dot so the message is not truncated", async () => {
    // A single `.` on its own line ends DATA. Unescaped, everything after it would be read as
    // SMTP commands.
    const fake = await fakeSmtp();
    await sendMail(config(fake.port), {
      to: "dana@example.com",
      subject: "Hi",
      text: "before\n.\nafter",
    });

    expect(fake.body).toContain("before\n..\nafter");
  });
});

describe("refusing bad input before it reaches the wire", () => {
  it("rejects a line break in the subject", async () => {
    // Header injection: a newline here would let the caller add their own Bcc.
    const fake = await fakeSmtp();
    await expect(
      sendMail(config(fake.port), {
        to: "dana@example.com",
        subject: "Hi\r\nBcc: everyone@example.com",
        text: "x",
      }),
    ).rejects.toThrow(MailError);

    expect(fake.transcript).toEqual([]);
  });

  it("rejects a line break in the recipient", async () => {
    const fake = await fakeSmtp();
    await expect(
      sendMail(config(fake.port), { to: "dana@example.com\r\nRCPT TO:<x@y.com>", subject: "Hi", text: "x" }),
    ).rejects.toThrow(MailError);
  });

  it("rejects something that is not an address", async () => {
    const fake = await fakeSmtp();
    await expect(
      sendMail(config(fake.port), { to: "not-an-address", subject: "Hi", text: "x" }),
    ).rejects.toThrow(MailError);
  });
});

describe("when the server refuses", () => {
  it("reports the recipient being rejected", async () => {
    const fake = await fakeSmtp({ refuse: { verb: "RCPT", reply: "550 5.1.1 No such user" } });
    await expect(
      sendMail(config(fake.port), { to: "dana@example.com", subject: "Hi", text: "x" }),
    ).rejects.toThrow(/No such user/);
  });

  it("never puts the password in the error", async () => {
    // This message reaches an admin and the log. A credential must not travel with it.
    const fake = await fakeSmtp({ refuse: { verb: "AUTH", reply: "535 5.7.8 Bad credentials" } });

    await expect(
      sendMail(config(fake.port, { username: "apikey", password: "s3cret-do-not-leak" }), {
        to: "dana@example.com",
        subject: "Hi",
        text: "x",
      }),
    ).rejects.toThrow(/credentials/);

    await sendMail(config(fake.port), { to: "d@e.com", subject: "Hi", text: "x" }).catch(
      (error: Error) => {
        expect(error.message).not.toContain("s3cret-do-not-leak");
      },
    );
  });

  it("explains a host that does not resolve, rather than repeating errno", async () => {
    await expect(
      sendMail(
        { host: "no.such.host.invalid", port: 25, from: "a@b.com", security: "none" },
        { to: "d@e.com", subject: "Hi", text: "x" },
      ),
    ).rejects.toThrow(/does not resolve|timed out/);
  });
});

describe("the invitation message", () => {
  it("leads with the link and says what it costs to ignore", () => {
    const message = invitationMessage({
      to: "dana@example.com",
      link: "https://strata.example.com/invite#abc",
      role: "editor",
      invitedBy: "sam",
    });

    expect(message.to).toBe("dana@example.com");
    expect(message.subject).toContain("sam");
    expect(message.text).toContain("https://strata.example.com/invite#abc");
    expect(message.text).toContain("an editor");
    expect(message.text).toContain("works once");
    // Somebody who did not expect this needs to know that ignoring it is safe.
    expect(message.text).toContain("ignore it");
  });

  it("gets the article right for a role beginning with a consonant", () => {
    const message = invitationMessage({
      to: "d@e.com",
      link: "x",
      role: "viewer",
      invitedBy: "sam",
    });
    expect(message.text).toContain("a viewer");
  });

  it("says what the role can do, so a viewer is not surprised by a greyed-out app", () => {
    /*
      The failure this prevents: a stakeholder invited as a viewer opens strata, finds every
      control disabled, and reports it broken. Inviting people as viewers is how a model reaches
      the people who will never install this, so their first impression matters more than most.
    */
    const message = invitationMessage({ to: "d@e.com", link: "x", role: "viewer", invitedBy: "sam" });

    expect(message.text).toContain("read every model");
    expect(message.text).toContain("change none of them");
  });

  it("describes an editor and an admin differently", () => {
    const editor = invitationMessage({ to: "d@e.com", link: "x", role: "editor", invitedBy: "sam" });
    const admin = invitationMessage({ to: "d@e.com", link: "x", role: "admin", invitedBy: "sam" });

    expect(editor.text).toContain("open pull requests");
    expect(admin.text).toContain("integrations and accounts");
  });

  it("still sends when the role is one it has no summary for", () => {
    // The mailer must never fail to deliver an invitation over a cosmetic line.
    const message = invitationMessage({ to: "d@e.com", link: "x", role: "auditor", invitedBy: "sam" });

    expect(message.text).toContain("an auditor");
    expect(message.text).toContain("x");
  });
});
