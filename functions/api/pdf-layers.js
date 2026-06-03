export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    if (!body.pdf) return json({error: 'No PDF data'}, 400);

    // Decode base64
    const b64 = body.pdf;
    const binaryStr = atob(b64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

    // Parse PDF structure to find and decompress content streams
    const result = await parsePDF(bytes);
    return json(result);

  } catch(e) {
    return json({error: e.message, stack: e.stack?.slice(0,500)}, 500);
  }
}

async function decompress(data) {
  try {
    const ds = new DecompressionStream('deflate');
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    writer.write(data);
    writer.close();
    const chunks = [];
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    let len = 0;
    chunks.forEach(c => len += c.length);
    const out = new Uint8Array(len);
    let off = 0;
    chunks.forEach(c => { out.set(c, off); off += c.length; });
    return out;
  } catch(e) {
    // Try raw deflate
    try {
      const ds = new DecompressionStream('deflate-raw');
      const writer = ds.writable.getWriter();
      const reader = ds.readable.getReader();
      writer.write(data);
      writer.close();
      const chunks = [];
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      let len = 0;
      chunks.forEach(c => len += c.length);
      const out = new Uint8Array(len);
      let off = 0;
      chunks.forEach(c => { out.set(c, off); off += c.length; });
      return out;
    } catch(e2) {
      return null;
    }
  }
}

function findStreams(bytes) {
  // Find all "stream\r\n" or "stream\n" ... "endstream" sections
  const dec = new TextDecoder('latin1');
  const text = dec.decode(bytes);
  const streams = [];
  let pos = 0;
  while (pos < text.length) {
    const streamStart = text.indexOf('stream', pos);
    if (streamStart === -1) break;
    // Skip "stream\r\n" or "stream\n"
    let dataStart = streamStart + 6;
    if (text[dataStart] === '\r') dataStart++;
    if (text[dataStart] === '\n') dataStart++;
    const streamEnd = text.indexOf('endstream', dataStart);
    if (streamEnd === -1) break;
    // Get the dict before this stream
    const dictEnd = streamStart;
    const dictStart = text.lastIndexOf('<<', dictEnd);
    const dict = dictStart >= 0 ? text.slice(dictStart, dictEnd) : '';
    streams.push({
      dict,
      data: bytes.slice(dataStart, streamEnd),
      isCompressed: dict.includes('FlateDecode') || dict.includes('flatedecode')
    });
    pos = streamEnd + 9;
  }
  return streams;
}

async function parsePDF(bytes) {
  const dec = new TextDecoder('latin1');
  const fullText = dec.decode(bytes);
  
  // Get page size from MediaBox
  let pageH = 842;
  const mbMatch = fullText.match(/\/MediaBox\s*\[\s*[\d.]+\s+[\d.]+\s+[\d.]+\s+([\d.]+)/);
  if (mbMatch) pageH = parseFloat(mbMatch[1]);

  // Get ColorSpace names from Resources
  const csMap = {};
  // Match /CSn [/Separation /Name ...
  const csRe = /\/(CS\d+)\s*\[\/Separation\s+\/([^\s\/\]]+)/g;
  let m;
  while ((m = csRe.exec(fullText)) !== null) {
    csMap['/'+m[1]] = m[2];
  }

  // Find and decompress content streams
  let contentText = '';
  const streams = findStreams(bytes);
  
  for (const stream of streams) {
    // Only process page content streams (not image/font streams)
    if (stream.dict.includes('/Image') || stream.dict.includes('/Font')) continue;
    if (stream.dict.includes('/Subtype') && 
        (stream.dict.includes('/Image') || stream.dict.includes('/Type1') || stream.dict.includes('/TrueType'))) continue;
    
    let text = '';
    if (stream.isCompressed) {
      const decompressed = await decompress(stream.data);
      if (decompressed) {
        text = dec.decode(decompressed);
      }
    } else {
      text = dec.decode(stream.data);
    }
    
    // Check if this looks like a content stream (has PDF operators)
    if (text.includes(' re') || text.includes(' S\n') || text.includes(' CS')) {
      contentText += text + '\n';
    }
  }

  if (!contentText) {
    return {error: 'Could not decompress PDF content', csMap, pageH, streams: streams.length};
  }

  // Parse content stream for colored paths
  const groups = {};
  const lines = contentText.split('\n');
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

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const cmd = parts[parts.length-1];
    const args = parts.slice(0,-1);

    if (cmd === 'w' && args.length) { const v=parseFloat(args[0]); if(!isNaN(v)) curLW=v; }
    else if (cmd === 'CS' && args.length) { flush(); curCS = args[0]; }
    else if (cmd === 're' && args.length >= 4) {
      flush();
      const x=parseFloat(args[0]),y=parseFloat(args[1]),w=parseFloat(args[2]),h=parseFloat(args[3]);
      if (!isNaN(x+y+w+h)) pts = [[x,pageH-y-h],[x+w,pageH-y-h],[x+w,pageH-y],[x,pageH-y]];
    }
    else if (cmd === 'm' && args.length >= 2) {
      flush();
      const x=parseFloat(args[0]),y=parseFloat(args[1]);
      if (!isNaN(x+y)) pts = [[x, pageH-y]];
    }
    else if (cmd === 'l' && args.length >= 2) {
      const x=parseFloat(args[0]),y=parseFloat(args[1]);
      if (!isNaN(x+y)) pts.push([x, pageH-y]);
    }
    else if (cmd === 'S' || cmd === 's') { flush(); }
    else if (cmd === 'n' || cmd === 'Q') { pts = []; }
  }
  flush();

  const result = Object.entries(groups)
    .map(([key,g]) => ({key, name: g.name, paths: g.paths.filter(p => p.w > 2 || p.h > 2)}))
    .filter(g => g.paths.length > 0);

  return {csMap, groups: result, pageH, contentLength: contentText.length};
}

export async function onRequestOptions() {
  return new Response(null, {headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  }});
}

function json(data, status=200) {
  return new Response(JSON.stringify(data), {
    status, headers: {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}
  });
}
