/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  swcMinify: true,
  poweredByHeader: false,
  compress: true,
  onDemandEntries: {
    // Period (in ms) where the server will keep pages in the buffer
    maxInactiveAge: 60 * 1000,
    // Number of pages that should be kept simultaneously without being disposed
    pagesBufferLength: 5,
  },
  experimental: {
    // Increase timeout for chunk loading
    pageLoadTimeout: 60000,
  },
  webpack: (config, { isServer }) => {
    // Increase timeout for chunk loading
    config.watchOptions = {
      ...config.watchOptions,
      aggregateTimeout: 300,
      poll: 1000,
    };
    return config;
  },
};

module.exports = nextConfig; 