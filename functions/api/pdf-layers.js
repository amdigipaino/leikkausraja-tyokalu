export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    if (!body.pdf) return json({error: 'No PDF data'}, 400);

    const binaryStr = atob(body.pdf);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

    const result = await parsePDF(bytes);
    return json(result);
  } catch(e) {
    return json({error: e.message}, 500);
  }
}

async function decompress(data) {
  for (const format of ['deflate', 'deflate-raw']) {
    try {
      const ds = new DecompressionStream(format);
      const w = ds.writable.getWriter();
      const r = ds.readable.getReader();
      w.write(data); w.close();
      const chunks = [];
      while (true) { const {done, value} = await r.read(); if (done) break; chunks.push(value); }
      let len = 0; chunks.forEach(c => len += c.length);
      const out = new Uint8Array(len); let off = 0;
      chunks.forEach(c => { out.set(c, off); off += c.length; });
      return out;
    } catch(e) { continue; }
  }
  return null;
}

async function parsePDF(bytes) {
  const dec = new TextDecoder('latin1');
  const full = dec.decode(bytes);

  // Page height
  let pageH = 842;
  const mb = full.match(/\/MediaBox\s*\[\s*[\d.]+\s+[\d.]+\s+[\d.]+\s+([\d.]+)/);
  if (mb) pageH = parseFloat(mb[1]);

  // Spot color names from Resources
  const csMap = {};
  const csRe = /\/(CS\d+)\s*\[\/Separation\s+\/([^\s\/\]]+)/g;
  let m;
  while ((m = csRe.exec(full)) !== null) csMap['/'+m[1]] = m[2];

  // Find ALL streams and decompress
  let contentText = '';
  let pos = 0;
  while (pos < full.length) {
    const si = full.indexOf('stream', pos);
    if (si === -1) break;
    let ds = si + 6;
    if (full[ds] === '\r') ds++;
    if (full[ds] === '\n') ds++;
    const se = full.indexOf('endstream', ds);
    if (se === -1) break;
    const dictStart = full.lastIndexOf('<<', si);
    const dict = dictStart >= 0 ? full.slice(dictStart, si) : '';
    const isCompressed = dict.includes('FlateDecode');
    const streamData = bytes.slice(ds, se);
    pos = se + 9;

    // Skip non-content streams
    if (dict.includes('/Subtype/Type1C') || dict.includes('/Subtype/Image') ||
        dict.includes('/FunctionType') || dict.includes('/Subtype/XML')) continue;

    let text = '';
    if (isCompressed) {
      const decompressed = await decompress(streamData);
      if (decompressed) text = dec.decode(decompressed);
    } else {
      text = dec.decode(streamData);
    }

    // Accept streams that contain CS commands or path operators
    if (text.includes('CS\n') || text.includes(' CS\n') || text.includes('/CS')) {
      contentText += text + '\n';
    }
  }

  if (!contentText) {
    return {error: 'No content streams found', csMap, pageH};
  }

  // Parse operators
  const groups = {};
  let curCS = 'default';
  let curLW = 1;
  let pts = [];

  function flush() {
    if (pts.length < 2) { pts = []; return; }
    if (!groups[curCS]) groups[curCS] = {name: csMap[curCS] || curCS, paths: []};
    let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
    pts.forEach(([x,y]) => { x0=Math.min(x0,x); y0=Math.min(y0,y); x1=Math.max(x1,x); y1=Math.max(y1,y); });
    groups[curCS].paths.push({x0, y0, w: x1-x0, h: y1-y0, lw: curLW});
    pts = [];
  }

  // Parse line by line
  const lines = contentText.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (!parts.length) continue;
    const cmd = parts[parts.length-1];
    const args = parts.slice(0,-1);

    if (cmd === 'w' && args.length) { const v=parseFloat(args[0]); if(!isNaN(v)) curLW=v; }
    else if (cmd === 'CS' && args.length) { flush(); curCS = args[0]; }
    else if (cmd === 're' && args.length >= 4) {
      flush();
      const x=parseFloat(args[0]),y=parseFloat(args[1]),w=parseFloat(args[2]),h=parseFloat(args[3]);
      if (!isNaN(x+y+w+h) && (Math.abs(w)>1 || Math.abs(h)>1))
        pts = [[x,pageH-y-h],[x+w,pageH-y-h],[x+w,pageH-y],[x,pageH-y]];
    }
    else if (cmd === 'm' && args.length >= 2) {
      flush();
      const x=parseFloat(args[0]),y=parseFloat(args[1]);
      if (!isNaN(x+y)) pts = [[x,pageH-y]];
    }
    else if (cmd === 'l' && args.length >= 2) {
      const x=parseFloat(args[0]),y=parseFloat(args[1]);
      if (!isNaN(x+y)) pts.push([x,pageH-y]);
    }
    else if (cmd === 'S' || cmd === 's') flush();
    else if (cmd === 'n' || cmd === 'Q') pts = [];
  }
  flush();

  const result = Object.entries(groups)
    .map(([key,g]) => ({key, name: g.name, paths: g.paths.filter(p=>p.w>2||p.h>2)}))
    .filter(g => g.paths.length > 0);

  return {csMap, groups: result, pageH, debug: `${lines.length} lines, ${result.length} groups`};
}

export async function onRequestOptions() {
  return new Response(null, {headers:{
    'Access-Control-Allow-Origin':'*',
    'Access-Control-Allow-Methods':'POST,OPTIONS',
    'Access-Control-Allow-Headers':'Content-Type'
  }});
}

function json(data, status=200) {
  return new Response(JSON.stringify(data), {
    status, headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}
  });
}
