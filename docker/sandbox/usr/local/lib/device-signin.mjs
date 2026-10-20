const DEVICE_CODE_METHOD = "device_code";

function view(flow) {
  if (!flow) return { status: "idle" };
  const { status, userCode, verificationUri, expiresAt, error } = flow;
  return { status, userCode, verificationUri, expiresAt, error };
}

async function chooseDeviceCode(prompt) {
  if (prompt?.type === "select" && prompt.options?.some((option) => option.id === DEVICE_CODE_METHOD)) {
    return DEVICE_CODE_METHOD;
  }
  throw new Error("This sign-in needs a browser on the same machine, which a sandbox doesn't have.");
}

export function createDeviceSignin({ login, save, now = Date.now }) {
  let flow = null;

  function expireStaleCode() {
    if (flow?.status !== "pending" || flow.redeemed || now() < flow.expiresAt) return;
    flow.controller.abort();
    Object.assign(flow, { status: "error", error: "The sign-in code expired." });
  }

  function start() {
    expireStaleCode();
    if (flow?.status === "starting") return flow.started;
    if (flow?.status === "pending") return Promise.resolve(view(flow));
    const controller = new AbortController();
    const current = { status: "starting", controller };
    flow = current;
    current.started = new Promise((resolve) => {
      const settle = (patch) => {
        Object.assign(current, patch);
        resolve(view(current));
      };
      Promise.resolve()
        .then(() => login({
          signal: controller.signal,
          prompt: chooseDeviceCode,
          notify(event) {
            if (event?.type !== "device_code") return;
            settle({
              status: "pending",
              userCode: event.userCode,
              verificationUri: event.verificationUri,
              expiresAt: now() + event.expiresInSeconds * 1000,
            });
          },
        }))
        .then(async (credential) => {
          if (flow !== current) return settle({ status: "cancelled" });
          current.redeemed = true;
          await save(credential, controller.signal);
          settle({ status: "success" });
        })
        .catch((error) => {
          if (current.status === "error") return resolve(view(current));
          settle(controller.signal.aborted
            ? { status: "cancelled" }
            : { status: "error", error: error?.message || String(error) });
        });
    });
    return current.started;
  }

  function status() {
    expireStaleCode();
    return view(flow);
  }

  function cancel() {
    flow?.controller.abort();
    flow = null;
  }

  return { start, status, cancel };
}
