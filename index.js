const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
require("dotenv").config();
const { MongoClient, ServerApiVersion } = require("mongodb");

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.yfy0tas.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverApi: ServerApiVersion.v1,
});

//Custom Middleware
function verifyJWT(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.status(401).send("Unauthorized Access");
  }
  const token = authHeader.split(" ")[1];
  jwt.verify(token, process.env.ACCESS_TOKEN, function (err, decoded) {
    if (err) {
      return res.status(403).send({ message: "forbidden access" });
    }
    req.decoded = decoded;
    next();
  });
}

const usersCollection = client.db("dbBuyTop").collection("users");

async function dbConnect() {
  try {
    await client.connect();
    console.log("Database is Connected");
  } catch (error) {
    console.log(error.message);
  }
}
dbConnect();

app.put("/user/:email", async (req, res) => {
  const email = req.params.email;
  const user = req.body;
  const filter = { email: email };
  const options = { upsert: true };
  const updateDoc = {
    $set: user,
  };
  const result = await usersCollection.updateOne(filter, updateDoc, options);
  const token = jwt.sign(user, process.env.ACCESS_TOKEN, { expiresIn: "7d" });
  res.send({ result, token });
});

//Check Admin
app.get("/users/admin/:email", async (req, res) => {
  const user = await usersCollection.findOne({ email: req.params.email });
  res.send({ isAdmin: user?.role === "Admin" });
});
//Check Seller
app.get("/users/seller/:email", async (req, res) => {
  const user = await usersCollection.findOne({ email: req.params.email});
  res.send({isSeller: user?.role === "Seller"})
});

//Server Connection Status
app.get("/", (req, res) => {
  res.send("API is Running");
});

app.listen(port, () => console.log("Server is running through port: ", port));
