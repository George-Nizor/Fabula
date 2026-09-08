// A path as the person wrote it, made into one the pipeline host can open.
//
// The window runs on Windows; the pipeline runs in WSL; the person types what
// their machine shows them: E:\Music\bed.mp3, or \\wsl.localhost\Ubuntu\home\…
// Each has one honest WSL spelling, and a tool that took only the WSL one
// would make every import a translation exercise. POSIX paths pass through.

export function hostPath(value) {
  const text = String(value ?? "").trim();
  if (!text) return text;
  // \\wsl.localhost\<distro>\a\b or \\wsl$\<distro>\a\b → /a/b
  const wsl = text.match(/^\\\\(?:wsl\.localhost|wsl\$)\\[^\\]+(\\.*)$/i);
  if (wsl) return wsl[1].replace(/\\/g, "/") || "/";
  // E:\a\b or E:/a/b → /mnt/e/a/b
  const drive = text.match(/^([A-Za-z]):[\\/](.*)$/);
  if (drive) return `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, "/")}`.replace(/\/+$/, "");
  return text;
}
