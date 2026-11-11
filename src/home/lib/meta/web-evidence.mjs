/** OW-084 R1: only completed web searches prove which hosts a run consulted. */
export function webEvidenceOf(events) {
  let completed = 0;
  let with_urls = 0;
  const hosts = new Set();
  for (const event of events) {
    if (event.type !== 'item.completed' || event.item?.type !== 'web_search') continue;
    completed += 1;
    const item = event.item;
    const urls = [item.action?.url,
      ...(Array.isArray(item.results) ? item.results.map((result) => result?.url) : [])];
    let hasUrl = false;
    for (const value of urls) {
      if (typeof value !== 'string') continue;
      try {
        const url = new URL(value);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
        hasUrl = true;
        hosts.add(url.hostname.toLowerCase().replace(/^www\./, ''));
      } catch {
        // OW-084: malformed result URLs cannot prove a host for later citation checks.
      }
    }
    if (hasUrl) with_urls += 1;
  }
  return { completed, with_urls, hosts: [...hosts].sort() };
}
