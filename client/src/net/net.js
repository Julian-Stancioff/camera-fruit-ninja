// Socket.io client connection. Defaults to the deployed multiplayer server;
// override with ?mp=http://127.0.0.1:2599 for local testing.
import { io } from "socket.io-client";

const PARAMS = new URLSearchParams(location.search);
export const SERVER_URL = PARAMS.get("mp") || "https://fnmp-51-81-34-160.nip.io";

export function connect() {
  return io(SERVER_URL, { transports: ["websocket"], autoConnect: true, reconnection: false });
}
