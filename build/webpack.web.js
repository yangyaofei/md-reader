const { resolve } = require('path')
const { merge } = require('webpack-merge')
const MiniCssExtractPlugin = require('mini-css-extract-plugin')
const common = require('./webpack.common.js')

const pluginsWithoutCopy = common.plugins.filter(
  plugin => plugin.constructor.name !== 'CopyPlugin',
)

module.exports = merge(
  {
    ...common,
    entry: {
      'web-main': resolve(__dirname, '../src/web-main.ts'),
    },
    output: {
      filename: 'js/[name].[contenthash:8].js',
      path: resolve(__dirname, '../dist'),
      publicPath: '/',
    },
    plugins: [
      ...pluginsWithoutCopy.filter(
        plugin => plugin.constructor.name !== 'MiniCssExtractPlugin',
      ),
      new MiniCssExtractPlugin({
        filename: 'css/[name].[contenthash:8].css',
      }),
    ],
  },
  {
    mode: 'production',
    optimization: {
      minimize: true,
    },
  },
)
