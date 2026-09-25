import { PassThrough } from "node:stream";

/** Two linked PassThrough pairs standing in for a native-messaging pipe in tests. */
export function makeMockPipePair() {
  // client writes -> hostReadsFromClient; host writes -> clientReadsFromHost
  const clientToHost = new PassThrough();
  const hostToClient = new PassThrough();
  return {
    // What the client-under-test (NativeMessagingClient) sees:
    clientInput: hostToClient,
    clientOutput: clientToHost,
    // What the test's fake "extension" reads/writes:
    extensionInput: clientToHost,
    extensionOutput: hostToClient,
  };
}
