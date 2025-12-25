import "express-session";

declare module "express-session" {
  interface SessionData {
    userId?: number;
  }
}

declare global {
  namespace Express {
    interface Request {
      session: import("express-session").Session & import("express-session").SessionData;
    }
  }
}

export {};
