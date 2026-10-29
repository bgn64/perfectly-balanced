import { authHandler } from "../../../../server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) { return authHandler(request); }
export function POST(request: Request) { return authHandler(request); }
