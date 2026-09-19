import { createInterface } from "node:readline";
import { hashPassword } from "./auth.js";

/**
 * Print a password hash for `STRATA_ADMIN_PASSWORD_HASH`.
 *
 * ```
 * docker run --rm -it ghcr.io/<org>/strata node apps/server/dist/hash-password.js
 * ```
 *
 * **Why a separate entry point rather than a `strata` subcommand.** The CLI package depends on the
 * metamodel and the storage layer, and nothing else; `auth.ts` pulls in express types. Putting
 * this in the CLI would mean either dragging the server into it or writing scrypt a second time,
 * and a second implementation is one refactor away from producing hashes the server cannot
 * verify. That failure shows up as "the seeded administrator cannot sign in", which is a
 * miserable thing to debug at 2am on a new deployment.
 *
 * **Reads from stdin, not from an argument.** A password on the command line lands in shell
 * history and in the process list, where any other user on the box can read it. Reading it from
 * stdin means it goes nowhere but this process.
 */

async function main(): Promise<void> {
  const password = await read();

  if (password.length < 8) {
    process.stderr.write("passwords must be at least 8 characters\n");
    process.exit(1);
  }

  const hash = await hashPassword(password);

  /*
    The hash on stdout, the explanation on stderr.

    So `... | tr -d '\n' | pbcopy` and `... > hash.txt` both give a clean value, while somebody
    running it interactively still gets told what to do with it.
  */
  process.stderr.write("\nSet this on your deployment:\n\n");
  process.stdout.write(`${hash}\n`);
  process.stderr.write("\n  STRATA_ADMIN_PASSWORD_HASH=<the value above>\n");
  process.stderr.write("  STRATA_ADMIN_USERNAME=<the username you want>\n\n");
  process.stderr.write("The hash is safe to store in a Helm value or a Kubernetes Secret.\n");
}

/** Read one line from stdin, without echoing when we are attached to a terminal. */
function read(): Promise<string> {
  const input = createInterface({ input: process.stdin, output: process.stderr, terminal: true });

  return new Promise((resolve) => {
    /*
      Muted, so the password does not appear on screen or in a screen share.

      Written by hand because readline has no password mode: the output stream's write is
      replaced for the duration of the question, which is the documented way to do this without
      a dependency.
    */
    const output = input as unknown as { output?: NodeJS.WriteStream; _writeToOutput?: unknown };
    const originalWrite = output._writeToOutput;
    output._writeToOutput = function muted(this: unknown, text: string): void {
      if (text.includes("Password")) process.stderr.write(text);
    };

    input.question("Password: ", (answer) => {
      output._writeToOutput = originalWrite;
      input.close();
      process.stderr.write("\n");
      resolve(answer);
    });
  });
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
