const express = require('express');
const axios = require('axios');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const OpenAI = require('openai');
const path = require('path');
const cloudinary = require('cloudinary').v2;



const app = express();
// Allow up to 3 images
const upload = multer({ dest: 'uploads/' }).fields([
  { name: 'image1', maxCount: 1 },
  { name: 'image2', maxCount: 1 },
  { name: 'image3', maxCount: 1 },
]);

const PORT = 5000;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const SERP_API_KEY = process.env.SERP_API_KEY;
const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;


app.use(cors({ origin: '*' }));
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Map regions to Google domains and language codes
const regionConfig = {
  US: { google_domain: 'google.com', hl: 'en-US' },
  UK: { google_domain: 'google.co.uk', hl: 'en-GB' },
  CA: { google_domain: 'google.ca', hl: 'en-CA' },
  AU: { google_domain: 'google.com.au', hl: 'en-AU' },
  global: { google_domain: 'google.com', hl: 'en' },
};

// === IMAGE SCANNING ENDPOINT ===
app.post('/api/scan-image', upload, async (req, res) => {
  console.log('📥 Incoming multiple image scan request...');

  try {
    const files = Object.values(req.files).flat(); // flatten all uploaded files
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No images uploaded' });
    }

    const detectedKeywords = [];

    for (const file of files) {
      // Upload each file to Cloudinary
      const cloudRes = await cloudinary.uploader.upload(file.path, {
        folder: 'dealfinder',
      });
      fs.unlinkSync(file.path); // remove local file

      const imageUrl = cloudRes.secure_url;

      // Send each image to OpenAI
      const result = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are an assistant that identifies the exact product name, model, and series from images.',
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Identify the product and model in this image. Only return the name, nothing else.' },
              { type: 'image_url', image_url: { url: imageUrl } },
            ],
          },
        ],
      });

      const keyword = result.choices?.[0]?.message?.content?.trim();
      if (keyword) detectedKeywords.push(keyword);
    }

    // Combine all detected keywords
    const finalKeyword = detectedKeywords.join(' '); // merge multiple keywords

    // Call /api/search internally with combined keyword
    const region = req.query.region || 'global';
    const searchRes = await axios.get(`http://localhost:${PORT}/api/search`, {
      params: { q: finalKeyword, exact: false, region },
    });

    res.json({
      detectedKeyword: finalKeyword,
      region,
      ...searchRes.data,
    });
  } catch (err) {
    console.error('❌ Multi-Image Scan Error:', err);
    res.status(500).json({ error: 'Image processing failed', details: err.message });
  }
});


// === SEARCH ENDPOINT ===
app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  const exactMatch = req.query.exact === 'true';
  const region = req.query.region || 'global'; // Default to global if no region provided

  console.log(`🔎 Search request received. Query="${query}", Exact=${exactMatch}, Region=${region}`);

  if (!query) {
    console.warn('⚠ Missing query param');
    return res.status(400).json({ error: 'Missing query param ?q=' });
  }

  try {
    console.log('🌐 Calling SerpAPI...');
    const serpParams = {
      engine: 'google_shopping',
      q: query,
      api_key: SERP_API_KEY,
      ...regionConfig[region] || regionConfig.global, // Apply region-specific params
    };

    const serpResponse = await axios.get('https://serpapi.com/search.json', {
      params: serpParams,
    });

    console.log('📦 Raw SerpAPI Data received');

    const rawProducts = (serpResponse.data.shopping_results || []).slice(0, 10).map((item) => ({
      title: item.title,
      price: item.price,
      originalPrice: item.extracted_price || null,
      image: item.thumbnail || null,
      rating: item.rating || null,
      reviewCount: item.reviews || null,
      retailer: item.source || '',
      url: item.product_link || '',
      discount: item.extensions && item.extensions.length > 0 ? item.extensions[0] : null,
      availability: item.delivery || 'Check site',
      region, // Add region to product data
    }));

    if (!exactMatch) {
      console.log('✅ Returning raw SerpAPI products');
      return res.json({
        products: rawProducts,
        searchTerm: query,
        region,
        dataSource: 'serpapi',
      });
    }

    console.log('🧠 Sending products to Perplexity for filtering...');
    const prompt = `
You are a product filter assistant. Based on the shopping query, product list, and region, remove unrelated products.
Allow same product with different sizes/colors/variants.
Ensure products are relevant to the region: ${region}.

Query: "${query}"

Products (JSON):
${JSON.stringify(rawProducts, null, 2)}

Return only a clean JSON array of relevant products. No explanation.
    `;

    const perplexityResponse = await axios.post(
      'https://api.perplexity.ai/chat/completions',
      {
        model: 'sonar',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
      },
      {
        headers: {
          Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log('📦 Perplexity Raw Response received');

    let filteredProducts = [];
    const rawContent = perplexityResponse.data.choices[0].message.content;
    const cleanedContent = rawContent.replace(/```json/g, '').replace(/```/g, '').trim();

    try {
      filteredProducts = JSON.parse(cleanedContent);
    } catch (err) {
      console.error('⚠ Perplexity JSON parse error:', err.message);
      filteredProducts = rawProducts; // Fallback to raw products
    }

    console.log('✅ Returning filtered products');
    res.json({
      products: filteredProducts,
      searchTerm: query,
      region,
      dataSource: 'serpapi+perplexity',
    });
  } catch (error) {
    console.error('❌ Search Error:', error);
    res.status(500).json({ error: 'Failed to fetch or filter products', details: error.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));