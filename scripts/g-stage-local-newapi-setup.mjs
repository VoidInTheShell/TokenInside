const baseUrl = (process.env.G_STAGE_LOCAL_NEWAPI_URL ?? "http://127.0.0.1:3001").replace(/\/+$/, "");
const username = process.env.G_STAGE_LOCAL_NEWAPI_USERNAME ?? "groot";
const password = process.env.G_STAGE_LOCAL_NEWAPI_PASSWORD ?? "gtest-local-only-password";
const accessTokenOnly = process.argv.includes("--access-token-only");

async function request(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body === undefined ? {} : { "content-type": "application/json; charset=utf-8" }),
      ...init.headers,
    },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok || body.success === false) {
    throw new Error(body.message ?? `Local NewAPI HTTP ${response.status}`);
  }
  return { response, body: body.data ?? body };
}

const setup = await request("/api/setup");
if (!setup.body.status) {
  await request("/api/setup", {
    method: "POST",
    body: JSON.stringify({
      username,
      password,
      confirmPassword: password,
      SelfUseModeEnabled: false,
      DemoSiteEnabled: false,
    }),
  });
}

const login = await request("/api/user/login", {
  method: "POST",
  body: JSON.stringify({ username, password }),
});
const setCookie = login.response.headers.get("set-cookie") ?? "";
const cookie = setCookie.split(";", 1)[0];
if (!cookie) throw new Error("Local NewAPI login did not return a session cookie");
const sessionHeaders = { cookie, "New-Api-User": "1" };

const accessTokenResult = await request("/api/user/token", { headers: sessionHeaders });
const accessToken = typeof accessTokenResult.body === "string" ? accessTokenResult.body : accessTokenResult.body?.access_token;
if (!accessToken) throw new Error("Local NewAPI did not return an access token");

const existingChannels = await request("/api/channel/?p=0&page_size=100", { headers: sessionHeaders });
const staleChannelIds = (existingChannels.body?.items ?? [])
  .filter((item) => item?.name === "TokenInside G deterministic")
  .map((item) => Number(item.id))
  .filter(Number.isInteger);
if (staleChannelIds.length > 0) {
  await request("/api/channel/batch", {
    method: "POST",
    headers: sessionHeaders,
    body: JSON.stringify({ ids: staleChannelIds }),
  });
}

await request("/api/channel/", {
  method: "POST",
  headers: sessionHeaders,
  body: JSON.stringify({
    mode: "single",
    channel: {
      type: 1,
      key: "g-stage-upstream-key",
      status: 1,
      name: "TokenInside G deterministic",
      weight: 0,
      base_url: "http://host.docker.internal:13002",
      models: "g-stage-deterministic",
      group: "default",
      priority: 0,
      auto_ban: 0,
    },
  }),
});

await request("/api/option/", {
  method: "PUT",
  headers: sessionHeaders,
  body: JSON.stringify({
    key: "ModelRatio",
    value: JSON.stringify({ "g-stage-deterministic": 2 / 15 }),
  }),
});

if (accessTokenOnly) process.stdout.write(accessToken);
else console.log(JSON.stringify({ status: "ready", baseUrl, userId: 1, model: "g-stage-deterministic", accessTokenConfigured: true }));
