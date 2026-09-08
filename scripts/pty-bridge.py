#!/usr/bin/env python3
"""A pseudo-terminal for the assistant pane.

Runs a command inside a real terminal (Claude Code and Codex refuse a pipe),
relays its bytes to stdout and stdin's bytes to it, and resizes the terminal
when the window sends `ESC ] 7777 ; cols ; rows BEL` on stdin. Nothing else is
interpreted. When stdin closes the command is hung up and this exits with its
status. No dependency beyond the standard library, so it runs in the same WSL
that runs the pipeline and needs no native module built for Electron.
"""
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios

CTRL_START = b"\x1b]7777;"
CTRL_END = b"\x07"


def write_all(fd, data):
    while data:
        n = os.write(fd, data)
        data = data[n:]


def main():
    if len(sys.argv) < 4:
        sys.stderr.write("usage: pty-bridge.py COLS ROWS COMMAND [ARGS...]\n")
        return 64
    cols, rows, command = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3:]
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        os.environ["COLORTERM"] = "truecolor"
        try:
            os.execvp(command[0], command)
        except OSError as error:
            sys.stderr.write(f"cannot run {command[0]}: {error}\n")
            os._exit(127)

    def resize(c, r):
        if 1 <= c <= 1000 and 1 <= r <= 1000:
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))

    resize(cols, rows)
    pending = b""
    stdin_open = True
    while True:
        watch = [fd] + ([0] if stdin_open else [])
        try:
            ready, _, _ = select.select(watch, [], [])
        except InterruptedError:
            continue
        if fd in ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b""
            if not data:
                break
            write_all(1, data)
        if 0 in ready:
            try:
                data = os.read(0, 65536)
            except OSError:
                data = b""
            if not data:
                stdin_open = False
                try:
                    os.kill(pid, signal.SIGHUP)
                except ProcessLookupError:
                    pass
                continue
            pending += data
            out = b""
            while True:
                i = pending.find(CTRL_START)
                if i < 0:
                    out += pending
                    pending = b""
                    break
                out += pending[:i]
                j = pending.find(CTRL_END, i)
                if j < 0:
                    pending = pending[i:]  # a control sequence still arriving
                    break
                body = pending[i + len(CTRL_START):j]
                try:
                    c, r = (int(part) for part in body.split(b";"))
                    resize(c, r)
                except ValueError:
                    pass
                pending = pending[j + 1:]
            if out:
                write_all(fd, out)
    _, status = os.waitpid(pid, 0)
    return os.waitstatus_to_exitcode(status)


if __name__ == "__main__":
    sys.exit(main())
