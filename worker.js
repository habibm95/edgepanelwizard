const EDGE_TUNNEL_SOURCE =
  "https://raw.githubusercontent.com/cmliu/edgetunnel/main/_worker.js";

const CF_API =
  "https://api.cloudflare.com/client/v4";


function corsHeaders(){

  return {
    "Access-Control-Allow-Origin":"*",
    "Access-Control-Allow-Methods":"POST,OPTIONS",
    "Access-Control-Allow-Headers":"Content-Type",
    "Content-Type":"application/json; charset=utf-8"
  };

}


function response(data,status=200){

  return new Response(
    JSON.stringify(data),
    {
      status,
      headers:corsHeaders()
    }
  );

}


function randomString(length=16){

  const chars =
    "abcdefghijklmnopqrstuvwxyz0123456789";

  const bytes =
    new Uint8Array(length);

  crypto.getRandomValues(bytes);

  let result = "";

  for(const byte of bytes){

    result +=
      chars[byte % chars.length];

  }

  return result;

}


function projectName(){

  return (
    "et-" +
    randomString(12)
  );

}


function adminPassword(){

  return (
    "ET-" +
    randomString(30)
  );

}


async function cloudflare(
  token,
  path,
  options={}
){

  const response =
    await fetch(
      CF_API + path,
      {
        ...options,
        headers:{
          "Authorization":
            "Bearer " + token,

          ...(options.headers || {})
        }
      }
    );

  let data;

  try{
    data =
      await response.json();
  }
  catch{
    throw new Error(
      "Cloudflare returned an invalid response."
    );
  }

  if(
    !response.ok ||
    data.success === false
  ){

    const message =
      Array.isArray(data.errors)
        ? data.errors
            .map(
              error =>
                error.message ||
                JSON.stringify(error)
            )
            .join("; ")
        : "";

    throw new Error(
      message ||
      `Cloudflare API error: ${response.status}`
    );

  }

  return data;

}


/*
  Verify token and discover account.
*/

async function getAccount(token){

  const verify =
    await cloudflare(
      token,
      "/user/tokens/verify"
    );

  if(
    verify.result &&
    verify.result.status &&
    verify.result.status !== "active"
  ){

    throw new Error(
      "The Cloudflare API Token is not active."
    );

  }


  const accounts =
    await cloudflare(
      token,
      "/accounts?per_page=50"
    );


  if(
    !accounts.result ||
    !accounts.result.length
  ){

    throw new Error(
      "No Cloudflare account is available to this token."
    );

  }


  /*
    Same simple behavior intended by the wizard:
    use the first account returned to the token.
  */

  const account =
    accounts.result[0];


  return {
    id:account.id,
    name:account.name || ""
  };

}


/*
  Download the current EdgeTunnel main/_worker.js.
*/

async function getEdgeTunnel(){

  const response =
    await fetch(
      EDGE_TUNNEL_SOURCE,
      {
        cache:"no-store"
      }
    );

  if(!response.ok){

    throw new Error(
      "Unable to download the latest EdgeTunnel source."
    );

  }

  const source =
    await response.text();

  if(
    !source.includes("export default")
  ){

    throw new Error(
      "Downloaded EdgeTunnel source is invalid."
    );

  }

  return source;

}


/*
  Create KV namespace.
*/

async function createKV(
  token,
  accountId,
  name
){

  const result =
    await cloudflare(
      token,
      `/accounts/${accountId}/storage/kv/namespaces`,
      {
        method:"POST",

        headers:{
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            title:
              name + "-kv"
          })
      }
    );

  if(
    !result.result ||
    !result.result.id
  ){

    throw new Error(
      "Cloudflare did not return a KV namespace ID."
    );

  }

  return result.result.id;

}


/*
  Get workers.dev subdomain.
*/

async function getWorkersSubdomain(
  token,
  accountId
){

  try{

    const result =
      await cloudflare(
        token,
        `/accounts/${accountId}/workers/subdomain`
      );

    if(
      result.result &&
      result.result.subdomain
    ){

      return result.result.subdomain;

    }

  }
  catch{
    /*
      Some accounts do not have the
      subdomain API available.
    */
  }

  return null;

}


/*
  Deploy EdgeTunnel to Workers.
*/

async function deployWorker(
  token,
  accountId,
  scriptName,
  source,
  kvId,
  password
){

  const metadata = {

    main_module:"worker.js",

    compatibility_date:
      new Date()
        .toISOString()
        .slice(0,10),

    bindings:[
      {
        type:"kv_namespace",
        name:"KV",
        namespace_id:kvId
      },
      {
        type:"plain_text",
        name:"ADMIN",
        text:password
      }
    ]

  };


  const form =
    new FormData();


  form.append(
    "metadata",
    new Blob(
      [
        JSON.stringify(metadata)
      ],
      {
        type:
          "application/json"
      }
    )
  );


  form.append(
    "worker.js",
    new Blob(
      [source],
      {
        type:
          "application/javascript"
      }
    ),
    "worker.js"
  );


  await cloudflare(
    token,
    `/accounts/${accountId}/workers/scripts/${scriptName}`,
    {
      method:"PUT",
      body:form
    }
  );


  /*
    Try to enable the workers.dev subdomain.
  */

  try{

    await cloudflare(
      token,
      `/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`,
      {
        method:"POST",

        headers:{
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            enabled:true
          })
      }
    );

  }
  catch{
    /*
      Deployment itself succeeded.
      Subdomain may need to be enabled
      in the Cloudflare dashboard.
    */
  }


  const subdomain =
    await getWorkersSubdomain(
      token,
      accountId
    );


  if(subdomain){

    return (
      "https://" +
      scriptName +
      "." +
      subdomain
    );

  }


  return (
    "https://" +
    scriptName +
    ".workers.dev"
  );

}


/*
  Create Pages project.
*/

async function createPagesProject(
  token,
  accountId,
  name,
  kvId,
  password
){

  const result =
    await cloudflare(
      token,
      `/accounts/${accountId}/pages/projects`,
      {
        method:"POST",

        headers:{
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({

            name,

            production_branch:
              "main",

            deployment_configs:{
              production:{

                compatibility_date:
                  new Date()
                    .toISOString()
                    .slice(0,10),

                compatibility_flags:[
                  "nodejs_compat"
                ],

                kv_namespaces:{
                  KV:{
                    namespace_id:
                      kvId
                  }
                },

                env_vars:{
                  ADMIN:{
                    type:
                      "plain_text",
                    value:
                      password
                  }
                }

              }

            }

          })
      }
    );


  return result;

}


/*
  Deploy _worker.js to Pages.
*/

async function deployPages(
  token,
  accountId,
  name,
  source
){

  const form =
    new FormData();


  /*
    Pages Direct Upload accepts _worker.js
    directly.
  */

  form.append(
    "_worker.js",
    new Blob(
      [source],
      {
        type:
          "application/javascript"
      }
    ),
    "_worker.js"
  );


  /*
    Direct uploads require a manifest.
    EdgeTunnel only has one uploaded file.
  */

  const hashBuffer =
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(source)
    );


  const hashBytes =
    new Uint8Array(
      hashBuffer
    );


  /*
    Pages manifest uses a content hash.
  */

  let hash = "";

  for(
    const byte of
    hashBytes.slice(0,16)
  ){

    hash +=
      byte
        .toString(16)
        .padStart(2,"0");

  }


  form.append(
    "manifest",
    JSON.stringify({
      "/_worker.js":{
        hash,
        size:
          new TextEncoder()
            .encode(source)
            .byteLength
      }
    })
  );


  form.append(
    "branch",
    "main"
  );


  form.append(
    "commit_dirty",
    "false"
  );


  form.append(
    "commit_message",
    "EdgeTunnel Wizard deployment"
  );


  const result =
    await cloudflare(
      token,
      `/accounts/${accountId}/pages/projects/${name}/deployments`,
      {
        method:"POST",
        body:form
      }
    );


  if(
    result.result &&
    result.result.aliases &&
    result.result.aliases.length
  ){

    return result.result.aliases[0];

  }


  return (
    "https://" +
    name +
    ".pages.dev"
  );

}


/*
  Verify endpoint.
*/

async function verify(request){

  try{

    const body =
      await request.json();

    const token =
      String(body.token || "")
        .trim();

    if(!token){

      return response(
        {
          success:false,
          error:
            "Cloudflare API Token is required."
        },
        400
      );

    }


    const account =
      await getAccount(token);


    return response({
      success:true,
      account:{
        name:
          account.name
      }
    });

  }
  catch(error){

    return response(
      {
        success:false,
        error:
          error.message
      },
      400
    );

  }

}


/*
  Main deployment endpoint.
*/

async function deploy(request){

  const logs = [];


  try{

    const body =
      await request.json();


    const token =
      String(body.token || "")
        .trim();


    const method =
      String(body.method || "")
        .toLowerCase();


    if(!token){

      throw new Error(
        "Cloudflare API Token is required."
      );

    }


    if(
      method !== "workers" &&
      method !== "pages"
    ){

      throw new Error(
        "Invalid deployment method."
      );

    }


    logs.push(
      "Verifying Cloudflare token..."
    );


    const account =
      await getAccount(token);


    logs.push(
      "Cloudflare account detected."
    );


    logs.push(
      "Downloading latest EdgeTunnel source..."
    );


    const source =
      await getEdgeTunnel();


    logs.push(
      "Latest EdgeTunnel source downloaded."
    );


    const name =
      projectName();


    logs.push(
      "Generated project name: " +
      name
    );


    logs.push(
      "Creating KV namespace..."
    );


    const kvId =
      await createKV(
        token,
        account.id,
        name
      );


    logs.push(
      "KV namespace created."
    );


    /*
      EdgeTunnel uses ADMIN.
      We generate it automatically so
      the user never has to enter another field.
    */

    const password =
      adminPassword();


    let url;


    if(method === "workers"){

      logs.push(
        "Deploying EdgeTunnel Worker..."
      );


      url =
        await deployWorker(
          token,
          account.id,
          name,
          source,
          kvId,
          password
        );

    }
    else{

      logs.push(
        "Creating Cloudflare Pages project..."
      );


      await createPagesProject(
        token,
        account.id,
        name,
        kvId,
        password
      );


      logs.push(
        "Pages project created."
      );


      logs.push(
        "Uploading latest EdgeTunnel _worker.js..."
      );


      url =
        await deployPages(
          token,
          account.id,
          name,
          source
        );

    }


    logs.push(
      "Deployment completed successfully."
    );


    /*
      Do NOT return the ADMIN password to
      the frontend.
    */

    return response({
      success:true,
      url,
      logs
    });

  }
  catch(error){

    return response(
      {
        success:false,
        error:
          error.message,
        logs
      },
      400
    );

  }

}


export default {

  async fetch(request){

    if(
      request.method === "OPTIONS"
    ){

      return new Response(
        null,
        {
          status:204,
          headers:corsHeaders()
        }
      );

    }


    const url =
      new URL(request.url);


    if(
      request.method === "POST" &&
      url.pathname === "/api/verify"
    ){

      return verify(request);

    }


    if(
      request.method === "POST" &&
      url.pathname === "/api/deploy"
    ){

      return deploy(request);

    }


    return new Response(
      "EdgeTunnel Wizard API",
      {
        status:200
      }
    );

  }

};
