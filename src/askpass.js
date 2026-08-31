'use strict';

/* The program git and ssh run when they need a secret.
 *
 * Both ask the same way: run a program, hand it the question as an argument,
 * read one line from its standard output. This is that program. It is copied
 * into a runtime directory at startup and executed through a small shell stub,
 * because git needs something with an execute bit and a shebang, and this file
 * ships inside the application.
 *
 * The answer travels back over a unix socket rather than through a file or an
 * argument. An argument would sit in /proc/<pid>/cmdline for every process on
 * the machine to read for as long as git ran; a file would outlive the
 * question. A socket that only this account can open outlives nothing.
 *
 * Silence is the failure mode. Printing anything when the window cannot be
 * reached would hand git a guess as though a person had typed it, and git
 * would try it against the server. */

const net = require('net');

const sock = process.env.GITBRAID_ASKPASS_SOCK;
const op = process.env.GITBRAID_ASKPASS_OP || '';
const prompt = process.argv[2] || '';

function giveUp() { process.exit(1); }

if (!sock) giveUp();

const conn = net.connect(sock);
let answer = '';

/* Long, because a person is reading a dialog at the other end, but not
   forever: a window that never answers would leave git waiting for as long as
   the application ran. */
conn.setTimeout(15 * 60 * 1000, giveUp);
conn.on('connect', () => conn.write(`${JSON.stringify({ op, prompt })}\n`));
conn.on('data', (d) => { answer += d; });
conn.on('end', () => {
  if (!answer) giveUp();
  process.stdout.write(answer);
  process.exit(0);
});
conn.on('error', giveUp);
