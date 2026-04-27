const express = require('express')
const fs = require('fs')
const path = require('path')

const app = express()
const MARKDOWN_DIR = path.join(__dirname, '../')
const PUBLIC_DIR = path.join(__dirname, '../dist')

app.use(express.static(PUBLIC_DIR))

app.use('/raw', express.static(MARKDOWN_DIR))

app.get('/api/dir', (req, res) => {
  const relDir = req.query.path || '/'
  const absDir = path.join(MARKDOWN_DIR, relDir)

  if (!absDir.startsWith(MARKDOWN_DIR)) {
    return res.status(403).json({ error: 'Access denied' })
  }

  fs.readdir(absDir, { withFileTypes: true }, (err, entries) => {
    if (err) {
      return res.status(404).json({ error: 'Directory not found' })
    }

    const prefix = relDir === '/' ? '/' : relDir + '/'
    const files = []
    const dirs = []

    if (relDir !== '/') {
      const parentDir = path.dirname(relDir)
      dirs.push({
        name: '..',
        path: parentDir === '.' ? '/' : parentDir,
        isDirectory: true,
      })
    }

    entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach(entry => {
        if (
          entry.name.startsWith('.') ||
          entry.name === 'node_modules' ||
          entry.name === 'dist'
        )
          return
        const entryPath = prefix + entry.name
        if (entry.isDirectory()) {
          dirs.push({ name: entry.name, path: entryPath, isDirectory: true })
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          files.push({ name: entry.name, path: entryPath, isDirectory: false })
        }
      })

    res.json({ currentDir: relDir, dirs, files })
  })
})

app.use((req, res, next) => {
  if (req.path.endsWith('.md')) {
    res.sendFile(path.join(__dirname, 'index.html'))
  } else {
    next()
  }
})

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'))
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Markdown Web Server is running on http://localhost:${PORT}`)
})
