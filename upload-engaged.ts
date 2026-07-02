// ============================================================
// SPY AGENT — upload-engaged (SELF-CONTAINED)
// Extension uploads list of users who engaged on X
// Normalizes to lowercase for comparison ONLY — original casing
// is preserved in submissions/users tables separately
// ============================================================

const SUPABASE_URL          = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

function sbHeaders() {
  return {
    "apikey":        SUPABASE_SERVICE_ROLE,
    "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE}`,
    "Content-Type":  "application/json",
    "Prefer":        "return=representation",
  };
}

async function sbQuery(path: string, opts: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { ...sbHeaders(), ...(opts.headers as Record<string,string> ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase [${path}] ${res.status}: ${body}`);
  }
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("json")) return res.json();
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const body = await req.json().catch(() => null);

    if (!body?.state_id || !Array.isArray(body?.engaged_usernames)) {
      return new Response(
        JSON.stringify({ error: "Missing state_id or engaged_usernames array" }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }

    const { state_id, engaged_usernames } = body as {
      state_id:          string;
      engaged_usernames: string[];
    };

    // Normalize: lowercase, strip @, trim, dedupe
    // Underscore PRESERVED — see_ff stays see_ff (just lowercased for comparison)
    // Comparison in generate-report uses lower() on both sides so exact match works
    const normalized = [
      ...new Set(
        engaged_usernames
          .map((u: string) => u.trim().replace(/^@/, "").toLowerCase())
          .filter(Boolean)
      ),
    ];

    // Update extension_state
    await sbQuery(`extension_state?id=eq.${state_id}`, {
      method: "PATCH",
      body:   JSON.stringify({
        engaged_usernames: normalized,
        last_uploaded:     new Date().toISOString(),
        scan_status:       "uploaded",
      }),
    });

    // Async trigger generate-report (non-blocking)
    const generateUrl = `${SUPABASE_URL}/functions/v1/generate-report`;
    fetch(generateUrl, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE}`,
      },
      body: JSON.stringify({ state_id }),
    }).catch(e => console.error("generate-report trigger error:", e));

    return new Response(
      JSON.stringify({ ok: true, engaged_count: normalized.length }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("upload-engaged error:", e);
    return new Response(
      JSON.stringify({ error: String(e) }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }
});
