export function splitSseMessages(buffer: string): { messages: string[]; remainder: string } {
  const chunks = buffer.split("\n\n");
  const remainder = chunks.pop() || "";
  return { messages: chunks.filter(Boolean), remainder };
}

export function sseDataLine(message: string): string | null {
  return message.split("\n").find((line) => line.startsWith("data: ")) || null;
}
