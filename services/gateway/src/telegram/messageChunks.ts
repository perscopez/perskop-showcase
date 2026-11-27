export function splitTelegramMessage(text: string, maxLength = 3500): string[] {
  if (text.length <= maxLength) return [text];
  if (maxLength < 32) throw new Error("Telegram chunk limit is too small");

  const payloadLimit = maxLength - 16;
  const pieces: string[] = [];
  let remaining = text;
  while (remaining.length > payloadLimit) {
    const window = remaining.slice(0, payloadLimit);
    const minimumBreak = Math.floor(payloadLimit / 2);
    const newline = window.lastIndexOf("\n");
    const space = window.lastIndexOf(" ");
    const cut = Math.max(newline >= minimumBreak ? newline + 1 : 0, space >= minimumBreak ? space + 1 : 0) || payloadLimit;
    pieces.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining) pieces.push(remaining);
  return pieces.map((piece, index) => `[${index + 1}/${pieces.length}]\n${piece}`);
}
