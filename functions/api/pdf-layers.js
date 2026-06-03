// Cloudflare Pages Function: analyze PDF layers/spot colors server-side
export async function onRequestPost(context) {
  try {
    const formData = await context.request.formData();
    const file = formData.get('pdf');
    if (!file) return json({error: 'No PDF'}, 400);

    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);

    // Parse PDF stream to find spot colors and their paths
    const text = new TextDecoder('latin1').decode(bytes);
    
    // Find ColorSpace resources
    const csMap = {};
    const csRegex = /\/(CS\d+)\s*\[\/Separation\s*\/([^\s\/\]]+)/g;
    let m;
    while ((m = csRegex.exec(text)) !== null) {
      csMap['/'+m[1]] = m[2].replace(/\//g,'');
    }

    // Find all layers (OCGs)
    const layers = [];
    const ocgRegex = /\/Name\s*\(([^)]+)\)/g;
    while ((m = ocgRegex.exec(text)) !== null) {
      if (!layers.includes(m[1])) layers.push(m[1]);
    }

    // Parse content stream for colored paths
    // Find CS commands followed by paths and S command
    const groups = {};
    
    // Simple line-by-line parse
    const lines = text.split('\n');
    let curCS = 'default';
    let curLW = 1;
    let curPaths = [];
    let curPts = [];
    let pageH = 842; // default A4

    // Get page size
    const pbMatch = text.match(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
    if (pbMatch) pageH = parseFloat(pbMatch[4]);

    function flushPath() {
      if (curPts.length < 2) return;
      const key = curCS;
      const name = csMap[curCS] || curCS;
      if (!groups[key]) groups[key] = {name, paths: []};
      let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
      curPts.forEach(([x,y])=>{x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);});
      groups[key].paths.push({x0,y0,w:x1-x0,h:y1-y0,lw:curLW});
      curPts = [];
    }

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length === 0) continue;
      const cmd = parts[parts.length-1];
      const args = parts.slice(0,-1);

      if (cmd === 'w') curLW = parseFloat(args[0])||1;
      else if (cmd === 'CS' && args[0]) curCS = args[0];
      else if (cmd === 'cs' && args[0]) { /* fill cs, ignore */ }
      else if (cmd === 're' && args.length >= 4) {
        flushPath();
        const x=parseFloat(args[0]),y=parseFloat(args[1]),w=parseFloat(args[2]),h=parseFloat(args[3]);
        curPts = [[x,pageH-y-h],[x+w,pageH-y-h],[x+w,pageH-y],[x,pageH-y]];
      }
      else if (cmd === 'm' && args.length >= 2) {
        flushPath();
        curPts = [[parseFloat(args[0]),pageH-parseFloat(args[1])]];
      }
      else if (cmd === 'l' && args.length >= 2) curPts.push([parseFloat(args[0]),pageH-parseFloat(args[1])]);
      else if (cmd === 'S' || cmd === 's') { flushPath(); }
      else if (cmd === 'n' || cmd === 'Q') curPts = [];
    }

    // Build result
    const result = Object.entries(groups)
      .filter(([,g]) => g.paths.length > 0)
      .map(([key, g]) => ({
        key,
        name: g.name,
        count: g.paths.length,
        paths: g.paths.filter(p => p.w > 2 || p.h > 2).slice(0, 100)
      }));

    return json({
      colorspaces: csMap,
      layers,
      groups: result,
      pageH
    });

  } catch(e) {
    return json({error: e.message}, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, {headers: {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'}});
}

function json(data, status=200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}
  });
}
