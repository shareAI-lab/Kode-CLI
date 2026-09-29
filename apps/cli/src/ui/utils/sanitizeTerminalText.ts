/**
 * Sanitize text that came from an MCP server before rendering it in the
 * terminal.
 *
 * Ink passes string content straight through to stdout, so a malicious (or
 * compromised) MCP server could otherwise emit ANSI/CSI/OSC sequences and
 * clear the screen, move the cursor or repaint earlier lines to forge Kode's
 * own UI.
 *
 * Used by the elicitation form (`message`, field titles/descriptions, enum
 * options, URL-mode links). Other render paths for server-controlled text —
 * tool results, resource contents — do not go through this yet.
 *
 * Escape sequences and control characters are removed; newlines and tabs are
 * optionally preserved for multi-line bodies.
 */
export function sanitizeTerminalText(
  value: unknown,
  options: { allowNewlines?: boolean } = {},
): string {
  if (typeof value !== 'string' || value.length === 0) return ''

  let text = value
    // OSC: ESC ] ... (BEL | ESC \) — window titles, hyperlinks.
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    // CSI: ESC [ parameter-bytes(0x30-0x3F) intermediate-bytes(0x20-0x2F) final.
    // The parameter class must cover ':' '<' '=' '>' as well as digits and ';',
    // e.g. `ESC[38:2::255:0:0m` (colon colour form) or `ESC[<0;10;10M`.
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    // Other ESC-prefixed two-character sequences.
    .replace(/\u001b[@-Z\\-_]/g, '')

  if (options.allowNewlines) {
    // Keep \n (u000a) and \t (u0009); drop every other C0/C1 control character.
    text = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
  } else {
    text = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
  }

  // Bidi overrides can visually reorder rendered text (Trojan Source style).
  text = text.replace(/[\u202a-\u202e\u2066-\u2069]/g, '')

  return options.allowNewlines ? text : text.replace(/\s+/g, ' ').trim()
}
