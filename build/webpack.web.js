const { resolve } = require('path')
const { merge } = require('webpack-merge')
const common = require('./webpack.common.js')

// Filter out CopyWebpackPlugin as we don't need manifest.json, popup.html, etc. for the web build
const pluginsWithoutCopy = common.plugins.filter(plugin => plugin.constructor.name !== 'CopyPlugin');

module.exports = merge(
  {
    ...common,
    entry: {
      'web-main': resolve(__dirname, '../src/web-main.ts'),
    },
    output: {
      filename: 'js/[name].js',
      path: resolve(__dirname, '../dist'),
      publicPath: '/', // Ensure proper loading of assets in nested routes
    },
    plugins: pluginsWithoutCopy,
  },
  {
    mode: 'production', // Or make it configurable, but production by default is fine for now
    optimization: {
      minimize: true,
    },
  }
)
