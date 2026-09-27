export async function handler(_event: unknown): Promise<{ healthy: boolean; latencyMs: number }> {
  const publicUrl = process.env.PUBLIC_URL ?? '';
  if (!publicUrl) {
    console.log('No PUBLIC_URL configured, skipping external probe');
    return { healthy: true, latencyMs: 0 };
  }

  const target = `${publicUrl.replace(/\/$/, '')}/api/health`;
  const start = Date.now();

  try {
    const res = await fetch(target, {
      method: 'GET',
      headers: { 'user-agent': 'Devlog-Narrator-Probe/1.0' },
      signal: AbortSignal.timeout(10000),
    });

    const latencyMs = Date.now() - start;

    if (res.status === 200) {
      const data = (await res.json()) as { version?: string };
      console.log(`Probe healthy: ${res.status} in ${latencyMs}ms, version=${data.version}`);
      return { healthy: true, latencyMs };
    }

    console.warn(`Probe unhealthy: HTTP ${res.status} in ${latencyMs}ms`);
    return { healthy: false, latencyMs };
  } catch (err: unknown) {
    const latencyMs = Date.now() - start;
    console.error(`Probe failed: ${err instanceof Error ? err.message : String(err)}`);
    return { healthy: false, latencyMs };
  }
}
