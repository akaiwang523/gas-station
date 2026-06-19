import { Request, Response, NextFunction, RequestHandler } from 'express'

// 包住 async 的 route handler：只要裡面任何一個 await 丟出例外，
// 都會被自動轉交給 next(err)，最後由 errorHandler 接住、回傳 500，
// 而不會變成 unhandled rejection 把整個 process 弄掛。
export function asyncHandler(fn: RequestHandler): RequestHandler {
  return function (req: Request, res: Response, next: NextFunction) {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
}
