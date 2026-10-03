export class GameError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export function assert(cond: unknown, code: string, message: string, status = 400): asserts cond {
  if (!cond) throw new GameError(code, message, status);
}
