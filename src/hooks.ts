export type Hooks = {
  before?: (req: Request) => void | Promise<void>
  after?: (req: Request, res: Response) => void | Promise<void>
  onError?: (req: Request, err: unknown) => void | Promise<void>
  onRetry?: (
    req: Request,
    attempt: number,
    err?: unknown,
    res?: Response
  ) => void | Promise<void>
  onTimeout?: (req: Request) => void | Promise<void>
  onAbort?: (req: Request) => void | Promise<void>
  onCircuitOpen?: (req: Request) => void | Promise<void>
  onComplete?: (
    req: Request,
    res?: Response,
    err?: unknown
  ) => void | Promise<void>
}
