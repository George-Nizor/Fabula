"""A pseudo-terminal for the assistant pane on Windows.

The Windows counterpart of pty-bridge.py, with the same contract:

    python pty-bridge-win.py COLS ROWS COMMAND [ARGS...]

Runs COMMAND inside a real console (a ConPTY, through pywinpty from the
WhisperX venv), because Claude Code and Codex refuse a pipe. The console's
output is relayed to stdout as UTF-8 bytes and stdin's bytes are typed into
it. `ESC ] 7777 ; cols ; rows BEL` on stdin resizes the console and is never
passed on; nothing else is interpreted. When stdin closes, the command and
everything it started are ended, and this exits with the command's status.

Started by the window with windowsHide, so the python console is hidden; the
command's console is the pseudo-console, which has no window, and the one
helper started here (taskkill) is started with CREATE_NO_WINDOW.
"""
import codecs
import os
import shutil
import subprocess
import sys
import threading
import time


CTRL_START = b"\x1b]7777;"
CTRL_END = b"\x07"
CREATE_NO_WINDOW = 0x08000000


def split_controls(pending):
    """Split stdin bytes into (text to type, resizes, bytes still arriving)."""
    out = b""
    sizes = []
    while True:
        i = pending.find(CTRL_START)
        if i < 0:
            # A control sequence may be cut anywhere, even inside its opener.
            keep = 0
            for n in range(min(len(CTRL_START) - 1, len(pending)), 0, -1):
                if pending.endswith(CTRL_START[:n]):
                    keep = n
                    break
            if keep:
                return out + pending[:-keep], sizes, pending[-keep:]
            return out + pending, sizes, b""
        out += pending[:i]
        j = pending.find(CTRL_END, i)
        if j < 0:
            return out, sizes, pending[i:]
        body = pending[i + len(CTRL_START):j]
        try:
            c, r = (int(part) for part in body.split(b";"))
            sizes.append((c, r))
        except ValueError:
            pass
        pending = pending[j + 1:]


def kill_tree(pid):
    """End the command and every process it started (claude.exe, its MCP server)."""
    try:
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], stdin=subprocess.DEVNULL,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       creationflags=CREATE_NO_WINDOW, timeout=10)
    except (OSError, subprocess.SubprocessError):
        pass


def main():
    if len(sys.argv) < 4:
        sys.stderr.write("usage: pty-bridge-win.py COLS ROWS COMMAND [ARGS...]\n")
        return 64
    cols, rows, command = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3:]
    cols = min(max(cols, 1), 1000)
    rows = min(max(rows, 1), 1000)
    program = command[0] if os.path.isabs(command[0]) else shutil.which(command[0])
    if not program:
        sys.stderr.write(f"cannot run {command[0]}: not found\n")
        return 127

    env = dict(os.environ)
    env["COLORTERM"] = "truecolor"
    block = "\0".join(f"{key}={value}" for key, value in env.items()) + "\0"

    from winpty import PTY, Backend  # here, so split_controls is testable anywhere

    pty = PTY(cols, rows, backend=Backend.ConPTY)
    try:
        pty.spawn(program, cmdline=" " + subprocess.list2cmdline(command[1:]), cwd=os.getcwd(), env=block)
    except Exception as error:  # WinptyError
        sys.stderr.write(f"cannot run {program}: {error}\n")
        return 127
    pid = pty.pid
    out = sys.stdout.buffer
    lock = threading.Lock()  # the pty's writes and resizes, from the input thread only, and the final kill

    def relay_output():
        while True:
            try:
                data = pty.read(blocking=True)
            except Exception:
                break
            if data:
                try:
                    out.write(data.encode("utf-8", "replace"))
                    out.flush()
                except OSError:
                    break
            elif not pty.isalive() or pty.iseof():
                break

    def relay_input():
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        pending = b""
        while True:
            try:
                data = os.read(0, 65536)
            except OSError:
                data = b""
            if not data:
                with lock:
                    kill_tree(pid)
                return
            text, sizes, pending = split_controls(pending + data)
            with lock:
                try:
                    for c, r in sizes:
                        if 1 <= c <= 1000 and 1 <= r <= 1000:
                            pty.set_size(c, r)
                    if text:
                        pty.write(decoder.decode(text))
                except Exception:
                    return  # the command has gone; the main loop sees it

    reader = threading.Thread(target=relay_output, daemon=True)
    reader.start()
    threading.Thread(target=relay_input, daemon=True).start()

    while pty.isalive():
        time.sleep(0.05)
    reader.join(2.0)  # what the command wrote last
    status = pty.get_exitstatus()
    try:
        out.flush()
    except OSError:
        pass
    return status if isinstance(status, int) else 1


if __name__ == "__main__":
    # Leave without waiting on the threads, which may still be blocked on a read.
    code = main()
    sys.stderr.flush()
    os._exit(code if 0 <= code < 2 ** 31 else 1)
