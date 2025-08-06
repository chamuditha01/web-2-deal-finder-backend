const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = 5000;

app.use(cors({
  origin: '*',
}));

app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'Missing query param ?q=' });

  try {
    const response = await axios.get('https://serpapi.com/search.json', {
      params: {
        engine: 'google_shopping',
        q: query,
        api_key: '0ac900afcd7b8b5ad666efe5ad25120c0dc17fa59c377645b6e57681bc352e6c',
      },
    });

    console.log('SerpAPI Response:', response.data);

    const products = (response.data.shopping_results || []).slice(0, 10).map((item) => ({
  title: item.title,
  price: item.price,
  originalPrice: item.extracted_price || null,
  image: item.thumbnail || null,
  rating: item.rating || null,
  reviewCount: item.reviews || null,
  retailer: item.source || '',
  url: item.product_link || '',
  discount: (item.extensions && item.extensions.length > 0) ? item.extensions[0] : null,
  availability: item.delivery || 'Check site'
}));


    res.json({ products, searchTerm: query, dataSource: 'serpapi' });
  } catch (error) {
    console.error('SerpAPI Error:', error.message);
    res.status(500).json({ error: 'Failed to fetch products from SerpAPI' });
  }
});

app.listen(PORT, () => console.log(`API running at http://localhost:${PORT}`));
