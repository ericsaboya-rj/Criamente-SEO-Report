// Upstash Redis via REST API — sem dependencia de pacote
var KV = {
  _url: function() { return process.env.KV_REST_API_URL; },
  _token: function() { return process.env.KV_REST_API_TOKEN; },
  get: async function(key) {
    var r = await fetch(this._url() + '/get/' + encodeURIComponent(key), {
      headers: { Authorization: 'Bearer ' + this._token() }
    });
    var d = await r.json();
    return d.result || null;
  },
  set: async function(key, value, opts) {
    var body = ['SET', key, typeof value === 'string' ? value : JSON.stringify(value)];
    if (opts && opts.ex) body.push('EX', opts.ex);
    var r = await fetch(this._url(), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + this._token(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return r.json();
  },
  del: async function(key) {
    var r = await fetch(this._url(), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + this._token(), 'Content-Type': 'application/json' },
      body: JSON.stringify(['DEL', key])
    });
    return r.json();
  }
};
var kv = KV;

function generateId() {
  var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  var id = '';
  for (var i = 0; i < 10; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

async function fetchHTML(url) {
  var lastErr = '';
  var userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (compatible; CriamenteSEOBot/1.0)'
  ];

  for (var ua of userAgents) {
    try {
      var controller = new AbortController();
      var timeoutId = setTimeout(function() { controller.abort(); }, 28000);
      var response = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': ua,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1'
        }
      });
      clearTimeout(timeoutId);
      if (!response.ok) { lastErr = 'HTTP ' + response.status; continue; }
      var text = await response.text();
      if (text.length < 100) { lastErr = 'Pagina vazia'; continue; }
      return text;
    } catch(e) {
      clearTimeout(timeoutId);
      lastErr = e.message || String(e);
      continue;
    }
  }
  throw new Error('Nao foi possivel acessar o site. Erro: ' + lastErr + '. Verifique se a URL e publica e tente novamente.');
}

// ── NOVAS VERIFICACOES ─────────────────────────────

function detectEmails(html) {
  var bodyText = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ');
  var emails = bodyText.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || [];
  var filtered = emails.filter(function(e) {
    return !e.match(/\.(png|jpg|gif|svg|woff|ttf|css|js)$/i) && !e.includes('example') && !e.includes('sentry');
  });
  var unique = [];
  filtered.forEach(function(e) { if (!unique.includes(e)) unique.push(e); });
  return unique;
}

function countInlineStyles(html) {
  return (html.match(/\bstyle\s*=\s*["'][^"']+["']/gi) || []).length;
}

function detectBlockingScripts(html) {
  return (html.match(/<script(?![^>]*(?:async|defer|type=["']module["']))[^>]+src=["'][^"']+["'][^>]*>/gi) || []).length;
}

function detectPixels(html) {
  var lower = html.toLowerCase();
  return {
    fbPixel:  lower.includes('connect.facebook.net') || lower.includes('fbevents'),
    gtm:      lower.includes('googletagmanager.com'),
    ga4:      lower.includes('gtag(') || lower.includes('google-analytics'),
    youtube:  lower.includes('youtube.com/embed'),
    linkedin: lower.includes('linkedin.com/insight'),
    hotjar:   lower.includes('hotjar.com') || lower.includes('_hjSettings'),
    clarity:  lower.includes('clarity.ms')
  };
}

function analyzeKeyword(title, h1, desc) {
  var stopWords = ['para','como','com','que','uma','por','mais','nos','das','dos','seu','sua','nao','mas','sobre','também','quando','onde','este','essa','isso','pelo','pela'];
  var words = (title||'').toLowerCase().split(/\s+/).filter(function(w) {
    return w.length > 4 && !stopWords.includes(w);
  });
  if (!words.length) return null;
  var kw = words[0];
  return {
    keyword: kw,
    inTitle: (title||'').toLowerCase().includes(kw),
    inH1:    (h1||'').toLowerCase().includes(kw),
    inDesc:  (desc||'').toLowerCase().includes(kw)
  };
}

async function fetchLlmsTxt(url) {
  try {
    var root = getRootUrl(url);
    var r = await fetch(root + '/llms.txt', { signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CriamenteSEOBot/1.0)' }
    });
    if (!r.ok) return { present: false };
    var text = await r.text();
    return text && text.length > 10 ? { present: true, size: text.length, sample: text.substring(0, 200) } : { present: false };
  } catch(e) { return { present: false }; }
}

async function fetchPageSpeed(url) {
  try {
    
    function parsePS(d) {
      if (!d || !d.lighthouseResult) return null;
      var cats = d.lighthouseResult.categories || {};
      var aud  = d.lighthouseResult.audits || {};
      return {
        performance:   Math.round(((cats.performance   || {}).score || 0) * 100),
        accessibility: Math.round(((cats.accessibility || {}).score || 0) * 100),
        bestPractices: Math.round(((cats['best-practices'] || {}).score || 0) * 100),
        seo:           Math.round(((cats.seo || {}).score || 0) * 100),
        fcp:  aud['first-contentful-paint']   && aud['first-contentful-paint'].displayValue  || '-',
        lcp:  aud['largest-contentful-paint'] && aud['largest-contentful-paint'].displayValue || '-',
        cls:  aud['cumulative-layout-shift']  && aud['cumulative-layout-shift'].displayValue  || '-',
        tbt:  aud['total-blocking-time']      && aud['total-blocking-time'].displayValue      || '-',
        si:   aud['speed-index']              && aud['speed-index'].displayValue              || '-',
        ttfb: aud['server-response-time']     && aud['server-response-time'].displayValue     || '-'
      };
    }
    var key = process.env.PAGESPEED_API_KEY ? '&key=' + process.env.PAGESPEED_API_KEY : '';
    var base = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=' + encodeURIComponent(url);
    var psResults = await Promise.all([
      fetch(base + '&strategy=mobile'  + key, { signal: AbortSignal.timeout(45000) }).then(function(r){ return r.ok ? r.json() : null; }).catch(function(){ return null; }),
      fetch(base + '&strategy=desktop' + key, { signal: AbortSignal.timeout(45000) }).then(function(r){ return r.ok ? r.json() : null; }).catch(function(){ return null; })
    ]);
    var mobile  = parsePS(psResults[0]);
    var desktop = parsePS(psResults[1]);
    if (!mobile && !desktop) return null;
    return { mobile: mobile, desktop: desktop };
  } catch(e) { return null; }
}

function getRootUrl(url) {
  try {
    var parsed = new URL(url);
    // Retorna sempre a raiz do host: protocolo + hostname
    return parsed.protocol + '//' + parsed.hostname;
  } catch(e) {
    return url;
  }
}

async function fetchRobotsTxt(url) {
  try {
    var rootUrl = getRootUrl(url);
    var r = await fetch(rootUrl + '/robots.txt', {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CriamenteSEOBot/1.0)' }
    });
    if (!r.ok) return null;
    var text = await r.text();
    if (text.length < 5) return null;
    return text;
  } catch(e) {
    return null;
  }
}

function analyzeRobotsTxt(txt, url) {
  if (!txt) return { present: false, hasDisallow: false, blocksSelf: false, hasSitemap: false, blocksAI: false, raw: null };
  var lower = txt.toLowerCase();
  var lines = txt.split('\n').map(function(l) { return l.trim(); });
  var disallows = lines.filter(function(l) { return l.toLowerCase().startsWith('disallow:') && l.split(':')[1] && l.split(':')[1].trim() !== ''; });
  var sitemapLine = lines.filter(function(l) { return l.toLowerCase().startsWith('sitemap:'); });
  var aiAgents = ['gptbot','chatgpt-user','amazonbot','ai2bot','claudebot','anthropic','perplexitybot','ccbot'];
  var blocksAI = aiAgents.some(function(a) { return lower.includes(a); });
  var host = ''; try { host = new URL(url).hostname; } catch(e) {}
  var blocksSelf = lines.some(function(l) {
    return l.toLowerCase().startsWith('disallow:') && l.includes('/') && l.split(':')[1] && l.split(':')[1].trim() === '/';
  });
  return {
    present: true,
    hasDisallow: disallows.length > 0,
    disallowCount: disallows.length,
    hasSitemap: sitemapLine.length > 0,
    sitemaps: sitemapLine.map(function(l) { return l.split(':').slice(1).join(':').trim(); }),
    blocksAI: blocksAI,
    blocksSelf: blocksSelf,
    raw: txt.substring(0, 500)
  };
}

function extractSEO(html, url) {
  var get = function(p) { var m = html.match(p); return m ? (m[1] || '').trim() : null; };
  var getAll = function(p) { return html.match(new RegExp(p.source, 'gi')) || []; };
  var title = get(/<title[^>]*>([^<]+)<\/title>/i);
  var description =
    get(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{10,})/i) ||
    get(/<meta[^>]+content=["']([^"']{10,})["'][^>]+name=["']description["']/i);
  var h1s = getAll(/<h1[^>]*>([^<]+)<\/h1>/i).map(function(h) { return h.replace(/<[^>]+>/g,'').trim(); }).filter(Boolean);
  var h2s = getAll(/<h2[^>]*>[^<]+<\/h2>/i).map(function(h) { return h.replace(/<[^>]+>/g,'').trim(); }).filter(Boolean);
  var canonical = get(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
  var robots    = get(/<meta[^>]+name=["']robots["'][^>]+content=["']([^"']+)["']/i);
  var viewport  = /<meta[^>]+name=["']viewport["']/i.test(html);
  var lang      = get(/<html[^>]+lang=["']([^"']+)["']/i);
  var ogTitle   = get(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  var ogDesc    = get(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
  var ogImage   = get(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  var twitterCard = get(/<meta[^>]+name=["']twitter:card["'][^>]+content=["']([^"']+)["']/i);
  var hasJsonLd = /<script[^>]+type=["']application\/ld\+json["']/i.test(html);
  var jsonLdTypes = [];
  (html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || []).forEach(function(s) {
    try {
      var d = JSON.parse(s.replace(/<[^>]+>/g,''));
      if (d['@type']) jsonLdTypes.push(d['@type']);
      if (d['@graph']) d['@graph'].forEach(function(g) { if (g['@type']) jsonLdTypes.push(g['@type']); });
    } catch(e) {}
  });
  var imgs = html.match(/<img[^>]*>/gi) || [];
  var imgsNoAlt = imgs.filter(function(i) { return !(/alt=["'][^"']+["']/i.test(i)); }).length;
  var host = ''; try { host = new URL(url).hostname; } catch(e) {}
  var allLinks = html.match(/<a[^>]+href=["']([^"']+)["']/gi) || [];
  var internalLinks = allLinks.filter(function(a) {
    try { var m = a.match(/href=["']([^"']+)["']/i); return new URL(m ? m[1] : '', url).hostname === host; } catch(e) { return false; }
  }).length;
  var bodyText = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
  var wordCount = bodyText.split(' ').filter(function(w) { return w.length > 2; }).length;
  var emails = detectEmails(html);
  var inlineStyles = countInlineStyles(html);
  var blockingScripts = detectBlockingScripts(html);
  var pixels = detectPixels(html);
  var keywordAnalysis = analyzeKeyword(title, h1s.length ? h1s[0] : null, description);
  var titleQuality = title
    ? (title.length < 30 ? 'curto' : title.length > 65 ? 'longo' : 'ok')
    : 'ausente';

  return {
    url: url, https: url.startsWith('https://'),
    title: title, titleLen: title ? title.length : 0, titleQuality: titleQuality,
    description: description, descLen: description ? description.length : 0,
    h1s: h1s.slice(0,5), h2s: h2s.slice(0,10), h2Count: h2s.length,
    canonical: canonical, robots: robots, viewport: viewport, lang: lang,
    ogTitle: ogTitle, ogDesc: ogDesc, ogImage: ogImage, twitterCard: twitterCard,
    hasJsonLd: hasJsonLd, jsonLdTypes: jsonLdTypes,
    imgs: imgs.length, imgsNoAlt: imgsNoAlt, internalLinks: internalLinks, wordCount: wordCount,
    bodyTextSample: bodyText.substring(0, 3000),
    robotsMeta: robots,
    emails: emails,
    inlineStyles: inlineStyles,
    blockingScripts: blockingScripts,
    pixels: pixels,
    keywordAnalysis: keywordAnalysis
  };
}

function repairAndParseJSON(text) {
  var clean = text.trim();

  // Remove wrapper markdown
  var mdMatch = clean.match(/```json\s*([\s\S]*?)```/);
  if (mdMatch) { clean = mdMatch[1].trim(); }
  else {
    var mdMatch2 = clean.match(/```\s*([\s\S]*?)```/);
    if (mdMatch2) { clean = mdMatch2[1].trim(); }
  }

  var start = clean.indexOf('{');
  var end = clean.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Nenhum JSON encontrado. Resposta: ' + text.substring(0, 300));
  var json = clean.substring(start, end + 1);

  // Tenta direto primeiro
  try { return JSON.parse(json); } catch(e) {}

  // Reparo nivel 1: normaliza chars invalidos dentro de strings
  var fixed = '';
  var inString = false;
  var escape = false;
  for (var i = 0; i < json.length; i++) {
    var ch = json[i];
    if (escape) { fixed += ch; escape = false; continue; }
    if (ch === '\\') { fixed += ch; escape = true; continue; }
    if (ch === '"') { inString = !inString; fixed += ch; continue; }
    if (inString) {
      if (ch === '\n' || ch === '\r') { fixed += ' '; continue; }
      if (ch === '\t') { fixed += ' '; continue; }
      // Remove outros chars de controle
      var code = ch.charCodeAt(0);
      if (code < 32) { continue; }
    }
    fixed += ch;
  }

  try { return JSON.parse(fixed); } catch(e2) {
    // Reparo nivel 2: remove trailing commas antes de } ou ]
    var fixed2 = fixed.replace(/,\s*([}\]])/g, '$1');
    try { return JSON.parse(fixed2); } catch(e3) {
      throw new Error('JSON invalido: ' + e3.message + ' | Trecho pos 2580: ' + fixed2.substring(2580, 2650));
    }
  }
}

async function callAI(seoData) {
  var apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY nao configurada nas variaveis do Vercel.');

  var endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey;

  var prompt = 'Voce e um consultor senior de SEO e GEO. Analise os dados do site e gere um relatorio estrategico em portugues do Brasil.\n\n'
    + 'DADOS DO SITE:\n'
    + 'URL: ' + seoData.url + '\n'
    + 'HTTPS: ' + seoData.https + '\n'
    + 'Title: ' + (seoData.title || 'AUSENTE') + ' (' + seoData.titleLen + ' chars)\n'
    + 'Meta Description: ' + (seoData.description || 'AUSENTE') + ' (' + seoData.descLen + ' chars)\n'
    + 'H1s: ' + (seoData.h1s.join(' | ') || 'NENHUM') + '\n'
    + 'H2s: ' + (seoData.h2s.join(' | ') || 'NENHUM') + '\n'
    + 'Canonical: ' + (seoData.canonical || 'AUSENTE') + '\n'
    + 'Robots meta tag: ' + (seoData.robotsMeta || 'nao definido') + '\n'
    + 'Robots.txt: ' + (seoData.robotsTxtData.present ? 'Presente' : 'AUSENTE') + '\n'
    + (seoData.robotsTxtData.present ? 'Robots.txt - Disallow rules: ' + seoData.robotsTxtData.disallowCount + '\n' : '')
    + (seoData.robotsTxtData.present ? 'Robots.txt - Sitemap declarado: ' + (seoData.robotsTxtData.hasSitemap ? seoData.robotsTxtData.sitemaps.join(', ') : 'nao') + '\n' : '')
    + (seoData.robotsTxtData.present ? 'Robots.txt - Bloqueia crawlers de IA: ' + (seoData.robotsTxtData.blocksAI ? 'SIM' : 'nao') + '\n' : '')
    + (seoData.robotsTxtData.blocksSelf ? 'ATENCAO: robots.txt bloqueia todo o site (Disallow: /)\n' : '')
    + 'Viewport: ' + (seoData.viewport ? 'sim' : 'nao') + '\n'
    + 'Lang: ' + (seoData.lang || 'AUSENTE NO HTML ESTATICO (pode ser injetado via JS por SPAs/Next.js)') + '\n'
    + 'Open Graph: title=' + (seoData.ogTitle ? 'sim' : 'nao') + ', desc=' + (seoData.ogDesc ? 'sim' : 'nao') + ', img=' + (seoData.ogImage ? 'sim' : 'nao') + '\n'
    + 'Twitter Card: ' + (seoData.twitterCard || 'ausente') + '\n'
    + 'JSON-LD: ' + (seoData.hasJsonLd ? 'sim, tipos: ' + seoData.jsonLdTypes.join(', ') : 'AUSENTE') + '\n'
    + 'Imagens: ' + seoData.imgs + ' total, ' + seoData.imgsNoAlt + ' sem alt\n'
    + 'Links internos: ' + seoData.internalLinks + '\n'
    + 'Palavras estimadas: ' + seoData.wordCount + '\n'
    + 'Conteudo:\n' + seoData.bodyTextSample + '\n\n'
    + 'Emails em texto claro: ' + (seoData.emails && seoData.emails.length ? seoData.emails.join(', ') : 'nenhum') + '\n'
    + 'Inline styles: ' + (seoData.inlineStyles || 0) + ' ocorrencias\n'
    + 'Scripts bloqueantes: ' + (seoData.blockingScripts || 0) + '\n'
    + 'Pixels/Tracking: GTM=' + (seoData.pixels && seoData.pixels.gtm ? 'sim' : 'nao') + ', GA4=' + (seoData.pixels && seoData.pixels.ga4 ? 'sim' : 'nao') + ', Facebook=' + (seoData.pixels && seoData.pixels.fbPixel ? 'sim' : 'nao') + ', Hotjar=' + (seoData.pixels && seoData.pixels.hotjar ? 'sim' : 'nao') + '\n'
    + 'llms.txt: ' + (seoData.llmsTxt && seoData.llmsTxt.present ? 'PRESENTE (' + seoData.llmsTxt.size + ' bytes)' : 'AUSENTE') + '\n'
    + 'PageSpeed Mobile: ' + (seoData.pageSpeed && seoData.pageSpeed.mobile ? 'Performance=' + seoData.pageSpeed.mobile.performance + ' Acessibilidade=' + seoData.pageSpeed.mobile.accessibility + ' BPraticas=' + seoData.pageSpeed.mobile.bestPractices + ' SEO=' + seoData.pageSpeed.mobile.seo + ' LCP=' + seoData.pageSpeed.mobile.lcp + ' CLS=' + seoData.pageSpeed.mobile.cls : 'nao disponivel') + '\n'
    + 'Qualidade do Title: ' + (seoData.titleQuality || 'nao avaliado') + '\n'
    + 'Keyword principal inferida: ' + (seoData.keywordAnalysis ? seoData.keywordAnalysis.keyword + ' — no title: ' + seoData.keywordAnalysis.inTitle + ', no H1: ' + seoData.keywordAnalysis.inH1 + ', na description: ' + seoData.keywordAnalysis.inDesc : 'nao identificada') + '\n'
    +     + 'IMPORTANTE: Esta ferramenta analisa APENAS a URL especifica fornecida, nao o site inteiro. Ao avaliar Open Graph, schema, canonical e outros elementos, restrinja o diagnostico a esta pagina especifica. Nao generalize para outras paginas do site. Se a pagina auditada for uma homepage de secao ou listagem, mencione que artigos e paginas internas podem ter configuracoes diferentes. Sites SPA (React, Next.js, Vue) podem injetar atributos via JavaScript apos o carregamento do HTML estatico — se identificar um SPA, mencione essa limitacao em vez de marcar o item como erro critico.\n\n'
    + 'IMPORTANTE: Retorne APENAS JSON valido. Todos os valores de string devem estar em uma unica linha, sem quebras de linha dentro das strings. Use ponto e virgula ou virgula para separar frases dentro das strings, nunca caractere de nova linha.\n\n'
    + 'Estrutura obrigatoria:\n'
    + '{"segmento":"string","resumo_executivo":"string sem quebra de linha","nivel_seo":"Critico|Regular|Bom|Excelente","score_estimado":0,'
    + '"metricas":{"titulo":{"status":"ok|alerta|critico","texto":"string"},"description":{"status":"ok|alerta|critico","texto":"string"},"headings":{"status":"ok|alerta|critico","texto":"string"},"conteudo":{"status":"ok|alerta|critico","texto":"string"},"schema":{"status":"ok|alerta|critico","texto":"string"},"open_graph":{"status":"ok|alerta|critico","texto":"string"},"tecnico":{"status":"ok|alerta|critico","texto":"string"},"geo_ia":{"status":"ok|alerta|critico","texto":"string"}},'
    + '"acoes":[{"numero":1,"prioridade":"Critico|Alto|Medio","categoria":"string","titulo":"string","problema":"string sem quebra de linha","recomendacao":"string sem quebra de linha","impacto":"string","esforco":"Baixo|Medio|Alto","prazo":"string"}],'
    + '"oportunidades_keywords":[{"keyword":"string","intencao":"Informacional|Comercial|Transacional|BOFU","potencial":"Alto|Medio|Baixo","pagina_sugerida":"/url/"}],'
    + '"schema_recomendados":[{"tipo":"string","pagina":"string","impacto":"string","esforco":"Baixo|Medio"}],'
    + '"concorrentes_organicos":[{"nome":"string","url":"string","angulo":"string"}],'
    + '"proximo_passo_imediato":"string"}\n\n'
    + 'Gere 4 a 6 acoes, 6 a 10 keywords, 3 a 6 schemas, 3 a 5 concorrentes.';

  var response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 4000,
        responseMimeType: 'application/json',
        thinkingConfig: {
          thinkingBudget: 0
        }
      }
    })
  });

  if (!response.ok) {
    var errText = await response.text();
    throw new Error('Erro Gemini API: ' + errText.substring(0, 400));
  }

  var data = await response.json();
  var parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  var rawText = '';
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].text && !parts[i].thought) rawText += parts[i].text;
  }

  return repairAndParseJSON(rawText.trim());
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo nao permitido' });

  var body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  var url = body.url;
  if (!url) return res.status(400).json({ error: 'URL nao fornecida' });

  var normalizedUrl = url.trim();
  if (!normalizedUrl.startsWith('http')) normalizedUrl = 'https://' + normalizedUrl;

  try {
    var html    = await fetchHTML(normalizedUrl);
    var seoData = extractSEO(html, normalizedUrl);

    // Busca robots.txt na raiz correta do domínio (ignora subdiretórios)
    var robotsTxt = await fetchRobotsTxt(normalizedUrl);
    seoData.robotsTxtData = analyzeRobotsTxt(robotsTxt, normalizedUrl);

    // llms.txt e PageSpeed em paralelo
    var extras = await Promise.all([
      fetchLlmsTxt(normalizedUrl),
      fetchPageSpeed(normalizedUrl)
    ]);
    seoData.llmsTxt    = extras[0];
    seoData.pageSpeed  = extras[1];

    var report  = await callAI(seoData);
    report.url = normalizedUrl;
    report.geradoEm = new Date().toLocaleDateString('pt-BR', {day:'2-digit',month:'2-digit',year:'numeric'})
      + ' as ' + new Date().toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit'});
    report.dadosTecnicos = seoData;
    report.robotsTxt  = seoData.robotsTxtData;
    report.llmsTxt    = seoData.llmsTxt;
    report.pageSpeed  = seoData.pageSpeed;
    report.techChecks = {
      emails:          seoData.emails,
      inlineStyles:    seoData.inlineStyles,
      blockingScripts: seoData.blockingScripts,
      pixels:          seoData.pixels,
      keywordAnalysis: seoData.keywordAnalysis,
      titleQuality:    seoData.titleQuality
    };
    // Salva no KV com TTL de 90 dias
    var reportId = generateId();
    try {
      await kv.set('report:' + reportId, report, { ex: 60 * 60 * 24 * 90 });
      report.reportId = reportId;
    } catch(kvErr) {
      // KV falhou mas nao impede retornar o relatorio
      console.error('KV save error:', kvErr.message);
    }

    // Envia para Make → Google Sheets
    try {
      fetch('https://hook.us2.make.com/6lgcyv51fg2wn66t8b5iiqgsbc875qq3', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: report.geradoEm,
          url: report.url,
          score: report.score_estimado,
          nivel: report.nivel_seo,
          segmento: report.segmento,
          link: 'https://criamente.vercel.app/?report=' + reportId
        })
      });
    } catch(makeErr) {}

    // Modo summary — retorno condensado para chatbots
    if (body.mode === 'summary') {
      var top3 = (report.acoes || []).slice(0,3).map(function(a) { return a.titulo; });
      return res.status(200).json({
        success: true,
        resumo:  report.resumo_executivo,
        nivel:   report.nivel_seo,
        score:   report.score_estimado,
        top3_acoes: top3,
        link: 'https://criamente.vercel.app/?report=' + (report.reportId || '')
      });
    }

    return res.status(200).json({ success: true, report: report });
  } catch(err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};
