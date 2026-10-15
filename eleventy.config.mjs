export default function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy("support.js");
  eleventyConfig.addPassthroughCopy("assets");
  eleventyConfig.addPassthroughCopy("uploads");
  return { htmlTemplateEngine: false };
}
