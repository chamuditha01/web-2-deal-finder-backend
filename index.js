const express = require("express");
const axios = require('axios');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const OpenAI = require('openai');
const path = require('path');
const cloudinary = require('cloudinary').v2;
const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

// Access the API key from the environment variables
const apiKey = process.env.GOOGLE_API_KEY;

// Check if the API key is available
if (!apiKey) {
  throw new Error("API key not found. Please set the GOOGLE_API_KEY environment variable.");
}

const genAI = new GoogleGenerativeAI(apiKey);


const app = express();
// Allow up to 3 images
const upload = multer({ dest: 'uploads/' }).fields([
  { name: 'image1', maxCount: 1 },
  { name: 'image2', maxCount: 1 },
  { name: 'image3', maxCount: 1 },
]);

const PORT = 5000;

cloudinary.config({
  cloud_name: 'dgg3x0tb8', 
  api_key: '426589156186855',
  api_secret: 'jAuk8QgMSzMzFUZyLHSEBO7jv9Y',
});

//const SERP_API_KEY = '0ac900afcd7b8b5ad666efe5ad25120c0dc17fa59c377645b6e57681bc352e6c';
const SERP_API_KEY = process.env.SERP_API_KEY;
const PERPLEXITY_API_KEY = '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';
const OPENAI_API_KEY = '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';


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
    const files = Object.values(req.files).flat();
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No images uploaded' });
    }

    const detectedKeywords = [];

    for (const file of files) {
      // Upload to Cloudinary
      const cloudRes = await cloudinary.uploader.upload(file.path, {
        folder: 'dealfinder',
      });

      const imageUrl = cloudRes.secure_url;

      // Convert file to base64 (Gemini requires inline data if no public URL)
      const base64 = fs.readFileSync(file.path).toString('base64');
      fs.unlinkSync(file.path); // cleanup local file

      // Use Gemini Vision
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

      const prompt = "Identify the exact product brand and model in this image. Only return the name (e.g. 'Sony WH-1000XM5'). No extra words. If cant detect exact model. give model just you detected.";

      const result = await model.generateContent([
        { text: prompt },
        {
          inlineData: {
            data: base64,
            mimeType: file.mimetype || 'image/jpeg',
          },
        },
      ]);

      const keyword = result.response.text().trim();
      if (keyword) detectedKeywords.push(keyword);
    }

    // Combine all detected keywords
    const finalKeyword = detectedKeywords.join(' ');

    // Call /api/search internally with combined keyword
    const region = req.query.region || 'global';
    const searchRes = await axios.get(`https://web-2-deal-finder-backend-production.up.railway.app/api/search`, {
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