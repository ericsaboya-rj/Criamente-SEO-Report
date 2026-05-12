async function callAISummary(seoData) {
  var apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY nao configurada.');
  var endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey;
  var lines = [
    'Voce e consultor de SEO. Diagnostico em portugues.',
    'URL: ' + seoData.url,
    'Title: ' + (seoData.title || 'AUSENTE'),
    'Description: ' + (seoData.description || 'AUSENTE'),
    'H1: ' + (seoData.h1s && seoData.h1s[0] || 'AUSENTE'),
    'HTTPS: ' + seoData.https,
    'JSON-LD: ' + (seoData.hasJsonLd ? 'sim' : 'nao'),
    'OG: ' + (seoData.ogTitle && seoData.ogImage ? 'completo' : 'incompleto'),
    'Imgs sem alt: ' + seoData.imgsNoAlt + '/' + seoData.imgs,
    'Palavras: ' + seoData.wordCount,
    'Retorne APENAS JSON: {"resumo":"2-3 frases","nivel":"Critico|Regular|Bom|Excelente","score":0,"top3_acoes":["a1","a2","a3"]}'
  ];
  var prompt = lines.join('\n');
  var response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 500, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } }
    })
  });
  if (!response.ok) throw new Error('Erro Gemini: ' + (await response.text()).substring(0,200));
  var data = await response.json();
  var parts = (data.candidates&&data.candidates[0]&&data.candidates[0].content&&data.candidates[0].content.parts)||[];
  var text = '';
  for (var i=0;i<parts.length;i++) { if(parts[i].text&&!parts[i].thought) text+=parts[i].text; }
  text = text.trim();
  var s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s===-1||e===-1) throw new Error('JSON invalido');
  return JSON.parse(text.substring(s, e+1));
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

  // Modo summary — processa menos, responde rapido
  if (body.mode === 'summary') {
    try {
      var html = await fetchHTML(normalizedUrl);
      var seoData = extractSEO(html, normalizedUrl);
      var summary = await callAISummary(seoData);
      var reportId = generateId();
      try { await kv.set('report:' + reportId, { url: normalizedUrl, summary: true, score_estimado: summary.score, nivel_seo: summary.nivel, resumo_executivo: summary.resumo }, { ex: 60*60*24*90 }); } catch(e) {}
      return res.status(200).json({
        success: true,
        resumo: summary.resumo,
        nivel: summary.nivel,
        score: summary.score,
        top3_acoes: summary.top3_acoes,
        link: 'https://criamente.vercel.app/?report=' + reportId
      });
    } catch(err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

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

    return res.status(200).json({ success: true, report: report });
  } catch(err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};
