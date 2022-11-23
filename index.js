const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
require("dotenv").config();

const app = express.json();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

//Server Connection Status
app.get("/", (req, res) => {
    res.send("API is Running");
  });
  app.listen(port, () => console.log("Server is running through port: ", port));