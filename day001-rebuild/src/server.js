const express = require('express');
const cors = require('cors');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Color extraction endpoint
app.post('/api/extract', async (req, res) => {
  const { url } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    // Validate URL
    let targetUrl;
    try {
      targetUrl = new URL(url.startsWith('http') ? url : `https://${url}`);
    } catch {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    // Fetch the page
    const response = await fetch(targetUrl.href, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ColorDNA/1.0)',
        'Accept': 'text/html,text/css,*/*'
      },
      timeout: 10000
    });

    if (!response.ok) {
      return res.status(400).json({ error: `Couldn't reach that URL (${response.status})` });
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Extract colors from various sources
    const colors = new Set();

    // 1. Meta theme-color
    const themeColor = $('meta[name="theme-color"]').attr('content');
    if (themeColor) addColor(colors, themeColor);

    // 2. Inline styles
    $('[style]').each((_, el) => {
      const style = $(el).attr('style');
      extractColorsFromCSS(style, colors);
    });

    // 3. Style tags
    $('style').each((_, el) => {
      extractColorsFromCSS($(el).html(), colors);
    });

    // 4. Try to fetch main CSS files (first 3)
    const cssLinks = [];
    $('link[rel="stylesheet"]').each((_, el) => {
      const href = $(el).attr('href');
      if (href && cssLinks.length < 3) {
        try {
          const cssUrl = new URL(href, targetUrl.href);
          cssLinks.push(cssUrl.href);
        } catch {}
      }
    });

    for (const cssUrl of cssLinks) {
      try {
        const cssResponse = await fetch(cssUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ColorDNA/1.0)' },
          timeout: 5000
        });
        if (cssResponse.ok) {
          const css = await cssResponse.text();
          extractColorsFromCSS(css, colors);
        }
      } catch {}
    }

    // Convert to array and process
    let colorArray = Array.from(colors)
      .map(c => normalizeColor(c))
      .filter(c => c !== null)
      .filter((c, i, arr) => arr.indexOf(c) === i); // unique

    // Cluster similar colors and pick representatives
    colorArray = clusterColors(colorArray);

    // Limit to 8 colors max
    colorArray = colorArray.slice(0, 8);

    // Sort by luminance (dark to light)
    colorArray.sort((a, b) => getLuminance(a) - getLuminance(b));

    // If we don't have enough colors, return error
    if (colorArray.length < 2) {
      return res.status(400).json({ error: 'Couldn\'t extract enough colors from that URL' });
    }

    // Categorize colors
    const palette = categorizePalette(colorArray);

    // Generate vibe name
    const vibeName = generateVibeName(palette);

    // Get favicon
    let favicon = $('link[rel="icon"]').attr('href') || 
                  $('link[rel="shortcut icon"]').attr('href') ||
                  '/favicon.ico';
    try {
      favicon = new URL(favicon, targetUrl.href).href;
    } catch {
      favicon = null;
    }

    res.json({
      url: targetUrl.href,
      hostname: targetUrl.hostname,
      favicon,
      vibeName,
      palette,
      colors: colorArray
    });

  } catch (error) {
    console.error('Extraction error:', error);
    res.status(500).json({ error: 'Failed to extract colors. Try a different URL.' });
  }
});

// Extract hex/rgb colors from CSS text
function extractColorsFromCSS(css, colors) {
  if (!css) return;
  
  // Hex colors
  const hexRegex = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
  let match;
  while ((match = hexRegex.exec(css)) !== null) {
    colors.add(match[0]);
  }

  // RGB/RGBA
  const rgbRegex = /rgba?\s*\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+)?\s*\)/gi;
  while ((match = rgbRegex.exec(css)) !== null) {
    const r = parseInt(match[1]);
    const g = parseInt(match[2]);
    const b = parseInt(match[3]);
    if (r <= 255 && g <= 255 && b <= 255) {
      colors.add(`#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`);
    }
  }

  // HSL (convert to hex)
  const hslRegex = /hsla?\s*\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*(?:,\s*[\d.]+)?\s*\)/gi;
  while ((match = hslRegex.exec(css)) !== null) {
    const h = parseFloat(match[1]) / 360;
    const s = parseFloat(match[2]) / 100;
    const l = parseFloat(match[3]) / 100;
    const hex = hslToHex(h, s, l);
    if (hex) colors.add(hex);
  }
}

// Normalize color to 6-digit hex
function normalizeColor(color) {
  if (!color) return null;
  color = color.toLowerCase().trim();
  
  // Skip near-white and near-black extremes, and transparent
  if (color === 'transparent' || color === 'inherit' || color === 'currentcolor') {
    return null;
  }

  // 3-digit hex to 6-digit
  if (/^#[0-9a-f]{3}$/i.test(color)) {
    color = '#' + color[1] + color[1] + color[2] + color[2] + color[3] + color[3];
  }

  // Validate 6-digit hex
  if (/^#[0-9a-f]{6}$/i.test(color)) {
    return color;
  }

  return null;
}

// HSL to Hex
function hslToHex(h, s, l) {
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }
  const toHex = x => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// Get luminance of a hex color
function getLuminance(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

// Cluster similar colors (within distance threshold)
function clusterColors(colors, threshold = 30) {
  const clusters = [];
  
  for (const color of colors) {
    let added = false;
    for (const cluster of clusters) {
      if (colorDistance(color, cluster[0]) < threshold) {
        cluster.push(color);
        added = true;
        break;
      }
    }
    if (!added) {
      clusters.push([color]);
    }
  }

  // Return the most "vibrant" color from each cluster
  return clusters.map(cluster => {
    return cluster.reduce((best, c) => {
      const satA = getSaturation(best);
      const satB = getSaturation(c);
      return satB > satA ? c : best;
    });
  });
}

function colorDistance(c1, c2) {
  const r1 = parseInt(c1.slice(1, 3), 16);
  const g1 = parseInt(c1.slice(3, 5), 16);
  const b1 = parseInt(c1.slice(5, 7), 16);
  const r2 = parseInt(c2.slice(1, 3), 16);
  const g2 = parseInt(c2.slice(3, 5), 16);
  const b2 = parseInt(c2.slice(5, 7), 16);
  return Math.sqrt(Math.pow(r1 - r2, 2) + Math.pow(g1 - g2, 2) + Math.pow(b1 - b2, 2));
}

function getSaturation(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const l = (max + min) / 2;
  return l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
}

// Categorize palette into roles
function categorizePalette(colors) {
  const sorted = [...colors].sort((a, b) => getLuminance(a) - getLuminance(b));
  
  // Find most saturated for accent
  const bySaturation = [...colors].sort((a, b) => getSaturation(b) - getSaturation(a));
  
  return {
    background: sorted[sorted.length - 1], // lightest
    text: sorted[0], // darkest
    primary: bySaturation[0] || sorted[Math.floor(sorted.length / 2)],
    secondary: bySaturation[1] || sorted[Math.floor(sorted.length / 3)],
    accent: bySaturation[2] || bySaturation[0],
    all: colors
  };
}

// Generate evocative vibe name
function generateVibeName(palette) {
  const primary = palette.primary;
  const lum = getLuminance(primary);
  const sat = getSaturation(primary);
  const hue = getHue(primary);

  const moods = {
    dark: ['Midnight', 'Shadow', 'Deep', 'Obsidian', 'Carbon', 'Void'],
    light: ['Dawn', 'Cloud', 'Whisper', 'Pearl', 'Mist', 'Silk'],
    vibrant: ['Electric', 'Neon', 'Vivid', 'Bold', 'Pulse', 'Spark'],
    muted: ['Soft', 'Calm', 'Quiet', 'Gentle', 'Sage', 'Dusk']
  };

  const themes = {
    red: ['Rose', 'Ember', 'Crimson', 'Ruby', 'Coral', 'Flame'],
    orange: ['Amber', 'Copper', 'Sunset', 'Tangerine', 'Rust', 'Terra'],
    yellow: ['Gold', 'Honey', 'Lemon', 'Saffron', 'Butter', 'Sun'],
    green: ['Forest', 'Sage', 'Moss', 'Emerald', 'Mint', 'Fern'],
    cyan: ['Ocean', 'Teal', 'Aqua', 'Lagoon', 'Ice', 'Arctic'],
    blue: ['Sky', 'Navy', 'Azure', 'Cobalt', 'Storm', 'Denim'],
    purple: ['Violet', 'Plum', 'Lavender', 'Grape', 'Amethyst', 'Iris'],
    pink: ['Blush', 'Rose', 'Coral', 'Peach', 'Cherry', 'Fuchsia'],
    neutral: ['Stone', 'Slate', 'Steel', 'Ash', 'Silver', 'Iron']
  };

  // Determine mood
  let mood;
  if (lum < 0.3) mood = moods.dark;
  else if (lum > 0.7) mood = moods.light;
  else if (sat > 0.5) mood = moods.vibrant;
  else mood = moods.muted;

  // Determine theme from hue
  let theme;
  if (sat < 0.1) theme = themes.neutral;
  else if (hue < 15 || hue >= 345) theme = themes.red;
  else if (hue < 45) theme = themes.orange;
  else if (hue < 75) theme = themes.yellow;
  else if (hue < 150) theme = themes.green;
  else if (hue < 195) theme = themes.cyan;
  else if (hue < 260) theme = themes.blue;
  else if (hue < 300) theme = themes.purple;
  else theme = themes.pink;

  const moodWord = mood[Math.floor(Math.random() * mood.length)];
  const themeWord = theme[Math.floor(Math.random() * theme.length)];

  return `${moodWord} ${themeWord}`;
}

function getHue(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  let h;
  const d = max - min;
  switch (max) {
    case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
    case g: h = ((b - r) / d + 2) / 6; break;
    case b: h = ((r - g) / d + 4) / 6; break;
  }
  return Math.round(h * 360);
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Color DNA server running on port ${PORT}`);
});
