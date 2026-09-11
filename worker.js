const EDGE_TUNNEL_SOURCE =
  "https://raw.githubusercontent.com/cmliu/edgetunnel/main/_worker.js";

const CLOUDFLARE_API =
  "https://api.cloudflare.com/client/v4";

const COMPATIBILITY_DATE =
  new Date().toISOString().slice(0, 10);

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Pragma": "no-cache",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization",
        "Access-Control-Allow-Methods":
          "POST, OPTIONS"
      }
    }
  );
}

function error(message, status = 400, extra = {}) {
  return json(
    {
      success: false,
      error: message,
      ...extra
    },
    status
  );
}

function cors(response) {
  const headers =
    new Headers(response.headers);

  headers.set(
    "Access-Control-Allow-Origin",
    "*"
  );

  headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  headers.set(
    "Access-Control-Allow-Methods",
    "POST, OPTIONS"
  );

  headers.set(
    "Cache-Control",
    "no-store"
  );

  return new Response(
    response.body,
    {
      status: response.status,
      statusText: response.statusText,
      headers
    }
  );
}

function randomString(length = 12) {
  const chars =
    "abcdefghijklmnopqrstuvwxyz0123456789";

  const bytes =
    crypto.getRandomValues(
      new Uint8Array(length)
    );

  let output = "";

  for (const byte of bytes) {
    output +=
      chars[byte % chars.length];
  }

  return output;
}

function randomPassword() {
  const chars =
    "ABCDEFGHJKLMNPQRSTUVWXYZ" +
    "abcdefghijkmnopqrstuvwxyz" +
    "23456789" +
    "!@#$%";

  const bytes =
    crypto.getRandomValues(
      new Uint8Array(24)
    );

  let password = "";

  for (const byte of bytes) {
    password +=
      chars[byte % chars.length];
  }

  return "ET-" + password;
}

function projectName() {
  return (
    "edgetunnel-" +
    randomString(10)
  );
}

function kvName() {
  return (
    "edgetunnel-kv-" +
    randomString(8)
  );
}

async function cloudflare(
  token,
  path,
  options = {}
) {
  const response =
    await fetch(
      CLOUDFLARE_API + path,
      {
        ...options,
        headers: {
          Authorization:
            "Bearer " + token,

          ...(options.headers || {})
        }
      }
    );

  let data;

  try {
    data =
      await response.json();
  } catch {
    throw new Error(
      `Cloudflare returned HTTP ${response.status}.`
    );
  }

  if (
    !response.ok ||
    data.success === false
  ) {
    const message =
      data?.errors
        ?.map(
          item => item.message
        )
        ?.filter(Boolean)
        ?.join("; ");

    throw new Error(
      message ||
      `Cloudflare API error (${response.status}).`
    );
  }

  return data;
}

async function verifyToken(token) {
  const result =
    await cloudflare(
      token,
      "/user/tokens/verify"
    );

  if (!result.success) {
    throw new Error(
      "Cloudflare API Token is not valid."
    );
  }

  return true;
}

async function getAccounts(token) {
  const result =
    await cloudflare(
      token,
      "/accounts?per_page=100"
    );

  const accounts =
    Array.isArray(result.result)
      ? result.result
      : [];

  if (!accounts.length) {
    throw new Error(
      "No Cloudflare account is available for this API Token."
    );
  }

  return accounts;
}

async function getAccount(token) {
  const accounts =
    await getAccounts(token);

  return accounts[0];
}

async function fetchEdgeTunnel(logs) {
  logs.push(
    "Downloading latest EdgeTunnel from official GitHub..."
  );

  const response =
    await fetch(
      EDGE_TUNNEL_SOURCE,
      {
        headers: {
          Accept:
            "application/javascript,text/javascript,*/*"
        },
        cf: {
          cacheTtl: 0,
          cacheEverything: false
        }
      }
    );

  if (!response.ok) {
    throw new Error(
      "Could not download the latest EdgeTunnel source."
    );
  }

  const source =
    await response.text();

  if (
    source.length < 1000 ||
    !source.includes("fetch")
  ) {
    throw new Error(
      "The downloaded EdgeTunnel source looks invalid."
    );
  }

  logs.push(
    "Latest EdgeTunnel source downloaded."
  );

  return source;
}

async function createKV(
  token,
  accountId,
  logs
) {
  const name =
    kvName();

  logs.push(
    "Creating a new KV namespace..."
  );

  const result =
    await cloudflare(
      token,
      `/accounts/${accountId}/storage/kv/namespaces`,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({
          title: name
        })
      }
    );

  const id =
    result?.result?.id;

  if (!id) {
    throw new Error(
      "Cloudflare created the KV namespace but did not return its ID."
    );
  }

  logs.push(
    "KV namespace created."
  );

  return {
    id,
    name
  };
}

async function deleteKV(
  token,
  accountId,
  namespaceId
) {
  if (!namespaceId) return;

  try {
    await cloudflare(
      token,
      `/accounts/${accountId}/storage/kv/namespaces/${namespaceId}`,
      {
        method: "DELETE"
      }
    );
  } catch {
    // Ignore cleanup errors.
  }
}

async function ensureWorkersSubdomain(
  token,
  accountId,
  scriptName,
  logs
) {
  logs.push(
    "Checking workers.dev availability..."
  );

  try {
    const current =
      await cloudflare(
        token,
        `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/subdomain`
      );

    if (
      current?.result?.enabled
    ) {
      logs.push(
        "workers.dev is already enabled."
      );

      return true;
    }
  } catch {
    // Continue with enable attempt.
  }

  logs.push(
    "Enabling workers.dev..."
  );

  try {
    await cloudflare(
      token,
      `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/subdomain`,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({
          enabled: true,
          previews_enabled: true
        })
      }
    );

    logs.push(
      "workers.dev enabled."
    );

    return true;
  } catch {
    logs.push(
      "workers.dev could not be enabled automatically."
    );

    return false;
  }
}

async function getWorkersSubdomain(
  token,
  accountId
) {
  const result =
    await cloudflare(
      token,
      `/accounts/${accountId}/workers/subdomain`
    );

  return (
    result?.result?.subdomain ||
    null
  );
}

async function ensureAccountWorkersSubdomain(
  token,
  accountId,
  logs
) {
  try {
    const current =
      await getWorkersSubdomain(
        token,
        accountId
      );

    if (current) {
      return current;
    }
  } catch {
    // Try creation below.
  }

  logs.push(
    "Creating the account workers.dev subdomain..."
  );

  try {
    const created =
      await cloudflare(
        token,
        `/accounts/${accountId}/workers/subdomain`,
        {
          method: "PUT",

          headers: {
            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({})
        }
      );

    return (
      created?.result?.subdomain ||
      null
    );
  } catch {
    logs.push(
      "Account workers.dev subdomain could not be created automatically."
    );

    return null;
  }
}

async function uploadWorker(
  token,
  accountId,
  scriptName,
  source,
  kvId,
  adminPassword,
  logs
) {
  logs.push(
    "Preparing Worker configuration..."
  );

  const metadata = {
    main_module:
      "worker.js",

    compatibility_date:
      COMPATIBILITY_DATE,

    compatibility_flags: [
      "nodejs_compat"
    ],

    bindings: [
      {
        type:
          "kv_namespace",

        name:
          "KV",

        namespace_id:
          kvId
      },

      {
        type:
          "plain_text",

        name:
          "ADMIN",

        text:
          adminPassword
      }
    ]
  };

  const form =
    new FormData();

  form.append(
    "metadata",
    JSON.stringify(metadata)
  );

  form.append(
    "worker.js",
    new File(
      [source],
      "worker.js",
      {
        type:
          "application/javascript+module"
      }
    )
  );

  logs.push(
    "Uploading EdgeTunnel Worker..."
  );

  await cloudflare(
    token,
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}`,
    {
      method: "PUT",
      body: form
    }
  );

  logs.push(
    "Worker uploaded successfully."
  );
}

async function deployWorker(
  token,
  account,
  source,
  logs
) {
  const accountId =
    account.id;

  const scriptName =
    projectName();

  const adminPassword =
    randomPassword();

  let kv = null;

  try {
    kv =
      await createKV(
        token,
        accountId,
        logs
      );

    await uploadWorker(
      token,
      accountId,
      scriptName,
      source,
      kv.id,
      adminPassword,
      logs
    );

    await ensureWorkersSubdomain(
      token,
      accountId,
      scriptName,
      logs
    );

    const subdomain =
      await ensureAccountWorkersSubdomain(
        token,
        accountId,
        logs
      );

    if (!subdomain) {
      throw new Error(
        "Worker deployed, but Cloudflare did not provide a workers.dev subdomain."
      );
    }

    const url =
      `https://${scriptName}.${subdomain}`;

    logs.push(
      "Verifying deployed Worker..."
    );

    const verification =
      await fetch(
        url,
        {
          method:
            "GET",

          redirect:
            "manual"
        }
      );

    if (
      verification.status >= 500
    ) {
      throw new Error(
        `Worker verification returned HTTP ${verification.status}.`
      );
    }

    logs.push(
      "Worker verification completed."
    );

    return {
      success:
        true,

      platform:
        "workers",

      projectName:
        scriptName,

      url,

      adminUrl:
        url.replace(/\/+$/, "") +
        "/admin",

      adminPassword
    };

  } catch (e) {

    if (kv?.id) {
      logs.push(
        "Deployment failed. Cleaning up the newly created KV namespace..."
      );

      await deleteKV(
        token,
        accountId,
        kv.id
      );
    }

    throw e;
  }
}

async function createPagesProject(
  token,
  accountId,
  projectNameValue,
  kvId,
  adminPassword,
  logs
) {
  logs.push(
    "Creating Cloudflare Pages project..."
  );

  const body = {
    name:
      projectNameValue,

    production_branch:
      "main",

    deployment_configs: {
      production: {
        compatibility_date:
          COMPATIBILITY_DATE,

        compatibility_flags: [
          "nodejs_compat"
        ],

        kv_namespaces: {
          KV: {
            namespace_id:
              kvId
          }
        },

        env_vars: {
          ADMIN: {
            type:
              "secret_text",

            value:
              adminPassword
          }
        }
      }
    }
  };

  return await cloudflare(
    token,
    `/accounts/${accountId}/pages/projects`,
    {
      method:
        "POST",

      headers: {
        "Content-Type":
          "application/json"
      },

      body:
        JSON.stringify(body)
    }
  );
}

async function deployPages(
  token,
  account,
  source,
  logs
) {
  const accountId =
    account.id;

  const name =
    projectName();

  const adminPassword =
    randomPassword();

  let kv = null;

  let projectCreated =
    false;

  try {
    kv =
      await createKV(
        token,
        accountId,
        logs
      );

    await createPagesProject(
      token,
      accountId,
      name,
      kv.id,
      adminPassword,
      logs
    );

    projectCreated =
      true;

    logs.push(
      "Pages project created."
    );

    logs.push(
      "Uploading EdgeTunnel in Advanced Mode..."
    );

    const form =
      new FormData();

    form.append(
      "branch",
      "main"
    );

    form.append(
      "commit_dirty",
      "false"
    );

    form.append(
      "manifest",
      JSON.stringify({
        "_worker.js":
          await sha256Hex(source)
      })
    );

    form.append(
      "_worker.js",
      new File(
        [source],
        "_worker.js",
        {
          type:
            "application/javascript+module"
        }
      )
    );

    const deployment =
      await cloudflare(
        token,
        `/accounts/${accountId}/pages/projects/${encodeURIComponent(name)}/deployments`,
        {
          method:
            "POST",

          body:
            form
        }
      );

    logs.push(
      "Pages deployment uploaded."
    );

    const aliases =
      deployment?.result?.aliases;

    let url =
      Array.isArray(aliases) &&
      aliases.length
        ? aliases[0]
        : null;

    if (!url) {
      url =
        `https://${name}.pages.dev`;
    }

    logs.push(
      "Verifying Pages deployment..."
    );

    const check =
      await fetch(
        url,
        {
          method:
            "GET",

          redirect:
            "manual"
        }
      );

    if (
      check.status >= 500
    ) {
      throw new Error(
        `Pages verification returned HTTP ${check.status}.`
      );
    }

    logs.push(
      "Pages verification completed."
    );

    return {
      success:
        true,

      platform:
        "pages",

      projectName:
        name,

      url,

      adminUrl:
        url.replace(/\/+$/, "") +
        "/admin",

      adminPassword
    };

  } catch (e) {

    if (
      kv?.id &&
      !projectCreated
    ) {
      await deleteKV(
        token,
        accountId,
        kv.id
      );
    }

    throw e;
  }
}

async function sha256Hex(text) {
  const bytes =
    new TextEncoder().encode(text);

  const hash =
    await crypto.subtle.digest(
      "SHA-256",
      bytes
    );

  return [...new Uint8Array(hash)]
    .map(
      byte =>
        byte
          .toString(16)
          .padStart(2, "0")
    )
    .join("");
}

async function handleVerify(request) {
  let body;

  try {
    body =
      await request.json();
  } catch {
    return error(
      "Invalid JSON request."
    );
  }

  const token =
    String(body?.token || "")
      .trim();

  if (!token) {
    return error(
      "Cloudflare API Token is required."
    );
  }

  try {
    await verifyToken(
      token
    );

    const account =
      await getAccount(
        token
      );

    return json({
      success:
        true,

      accountName:
        account.name ||
        null
    });

  } catch (e) {
    return error(
      friendlyCloudflareError(
        e.message
      ),
      401
    );
  }
}

async function handleDeploy(request) {
  let body;

  try {
    body =
      await request.json();
  } catch {
    return error(
      "Invalid JSON request."
    );
  }

  const token =
    String(body?.token || "")
      .trim();

  const method =
    String(
      body?.method ||
      body?.platform ||
      ""
    )
      .toLowerCase();

  if (!token) {
    return error(
      "Cloudflare API Token is required."
    );
  }

  if (
    method !== "workers" &&
    method !== "pages"
  ) {
    return error(
      "Invalid deployment platform."
    );
  }

  const logs = [];

  try {
    logs.push(
      "Verifying Cloudflare API Token..."
    );

    await verifyToken(
      token
    );

    logs.push(
      "Cloudflare token verified."
    );

    logs.push(
      "Detecting Cloudflare account..."
    );

    const account =
      await getAccount(
        token
      );

    logs.push(
      `Account detected: ${account.name || account.id}`
    );

    const source =
      await fetchEdgeTunnel(
        logs
      );

    let result;

    if (
      method === "workers"
    ) {
      result =
        await deployWorker(
          token,
          account,
          source,
          logs
        );
    } else {
      result =
        await deployPages(
          token,
          account,
          source,
          logs
        );
    }

    logs.push(
      "EdgeTunnel installation finished successfully."
    );

    return json({
      ...result,
      logs
    });

  } catch (e) {

    logs.push(
      "ERROR: " +
      friendlyCloudflareError(
        e.message
      )
    );

    return error(
      friendlyCloudflareError(
        e.message
      ),
      500,
      {
        logs
      }
    );
  }
}

function friendlyCloudflareError(
  message
) {
  const text =
    String(message || "")
      .trim();

  if (!text) {
    return "Unknown Cloudflare API error.";
  }

  const lower =
    text.toLowerCase();

  if (
    lower.includes("authentication") ||
    lower.includes("invalid api token") ||
    lower.includes("invalid token") ||
    lower.includes("unauthorized")
  ) {
    return (
      "Cloudflare rejected the API Token. " +
      "Create a new token and make sure it has access to the selected account."
    );
  }

  if (
    lower.includes("permission") ||
    lower.includes("not authorized") ||
    lower.includes("forbidden")
  ) {
    return (
      "The API Token does not have enough permissions. " +
      "Make sure the token has Workers, Workers KV and Pages permissions."
    );
  }

  if (
    lower.includes("workers.dev") &&
    lower.includes("subdomain")
  ) {
    return (
      "Cloudflare could not enable workers.dev automatically. " +
      "Enable the workers.dev subdomain for this account and try again."
    );
  }

  return text;
}

export default {

  async fetch(request) {

    if (
      request.method === "OPTIONS"
    ) {
      return cors(
        new Response(
          null,
          {
            status:
              204,

            headers: {
              "Access-Control-Allow-Origin":
                "*",

              "Access-Control-Allow-Headers":
                "Content-Type, Authorization",

              "Access-Control-Allow-Methods":
                "POST, OPTIONS"
            }
          }
        )
      );
    }

    const url =
      new URL(request.url);

    if (
      request.method === "POST" &&
      url.pathname === "/api/verify"
    ) {
      return cors(
        await handleVerify(
          request
        )
      );
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/deploy"
    ) {
      return cors(
        await handleDeploy(
          request
        )
      );
    }

    return cors(
      json({
        success:
          true,

        name:
          "EdgeTunnel Wizard API",

        status:
          "online"
      })
    );
  }
};
