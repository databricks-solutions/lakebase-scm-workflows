require('dotenv').config();
const express = require('express');
const healthRoutes = require('./routes/health');

const app = express();
app.use(express.json());
app.use('/', healthRoutes);

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;
