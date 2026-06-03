export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const b64 = body.pdf;
    if (!b64) return json({error: 'No PDF data'}, 400);

    // Decode base64 to text (latin1 for binary-safe parsing)
    const binary = atob(b64);
    
    // Find page height
    let pageH = 842;
    const pbMatch = binary.match(/\/MediaBox\s*\[\s*[\d.]+\s+[\d.]+\s+[\d.]+\s+([\d.]+)/);
    if (pbMatch) pageH = parseFloat(pbMatch[1]);

    // Find ColorSpace names (spot colors)
    const csMap = {};
    const csRe = /\/(CS\d+)\s*\[\/Separation\s+\/([A-Za-z0-9_ ]+)/g;
    let m;
    while ((m = csRe.exec(binary)) !== null) {
      csMap['/'+m[1]] = m[2].trim();
    }
    // Also try without slash
    const csRe2 = /\/(CS\d+)\s*\[\/Separation\s+\(([^)]+)\)/g;
    while ((m = csRe2.exec(binary)) !== null) {
      csMap['/'+m[1]] = m[2].trim();
    }

    // Parse lines for colored paths
    const lines = binary.split('\n');
    let curCS = 'default';
    let curLW = 1;
    let pts = [];
    const groups = {};

    function flush() {
      if (pts.length < 2) { pts = []; return; }
      if (!groups[curCS]) groups[curCS] = { name: csMap[curCS] || curCS, paths: [] };
      let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
      pts.forEach(([x,y])=>{ x0=Math.min(x0,x); y0=Math.min(y0,y); x1=Math.max(x1,x); y1=Math.max(y1,y); });
      groups[curCS].paths.push({ x0, y0, w: x1-x0, h: y1-y0, lw: curLW });
      pts = [];
    }

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const parts = line.split(/\s+/);
      const cmd = parts[parts.length - 1];
      const args = parts.slice(0, -1);

      if (cmd === 'w' && args.length) {
        curLW = parseFloat(args[0]) || 1;
      } else if (cmd === 'CS' && args.length) {
        flush();
        curCS = args[0];
      } else if (cmd === 're' && args.length >= 4) {
        flush();
        const x=parseFloat(args[0]), y=parseFloat(args[1]), w=parseFloat(args[2]), h=parseFloat(args[3]);
        // Convert PDF coords (origin bottom-left) to canvas (origin top-left)
        pts = [[x, pageH-y-h],[x+w, pageH-y-h],[x+w, pageH-y],[x, pageH-y]];
      } else if (cmd === 'm' && args.length >= 2) {
        flush();
        pts = [[parseFloat(args[0]), pageH-parseFloat(args[1])]];
      } else if (cmd === 'l' && args.length >= 2) {
        pts.push([parseFloat(args[0]), pageH-parseFloat(args[1])]);
      } else if (cmd === 'S' || cmd === 's') {
        flush();
      } else if (cmd === 'n' || cmd === 'Q') {
        pts = [];
      }
    }
    flush();

    // Filter and format result
    const result = Object.entries(groups)
      .map(([key, g]) => ({
        key,
        name: g.name,
        paths: g.paths.filter(p => p.w > 2 || p.h > 2)
      }))
      .filter(g => g.paths.length > 0);

    return json({ csMap, groups: result, pageH });

  } catch(e) {
    return json({ error: e.message }, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  }});
}

function json(data, status=200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}
