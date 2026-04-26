const express = require('express');
const path = require('path');

const app = express();
const MARKDOWN_DIR = path.join(__dirname, '../'); // Serve raw MD files from root for demonstration/testing
const PUBLIC_DIR = path.join(__dirname, '../dist'); // Where webpack.web.js outputs

app.use(express.static(PUBLIC_DIR));

app.use('/raw', express.static(MARKDOWN_DIR));

app.get('/*.md', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/', (req, res) => {
  res.send('Welcome to Markdown Web Reader. Please navigate to a specific .md file (e.g., /README.md).');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Markdown Web Server is running on http://localhost:${PORT}`);
});
