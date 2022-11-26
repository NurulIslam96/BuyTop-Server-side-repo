const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

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
const productsCollection = client.db("dbBuyTop").collection("products");
const categoriesCollection = client.db("dbBuyTop").collection("categories");
const bookingCollection = client.db("dbBuyTop").collection("bookings");
const reportCollection = client.db("dbBuyTop").collection("reported");

//Verify Admin
const verifyAdmin = async (req, res, next) => {
  const query = { email: req.decoded.email };
  const user = await usersCollection.findOne(query);
  if (user.role !== "Admin") {
    res.status(403).send({ message: "forbidden access" });
  }
  next();
};

//Verify Seller
const verifySeller = async (req, res, next) => {
  const query = { email: req.decoded.email };
  const user = await usersCollection.findOne(query);
  if (user.role !== "Seller") {
    res.status(403).send({ message: "forbidden access" });
  }
  next();
};
//Verify Buyer
const verifyBuyer = async (req, res, next) => {
  const query = { email: req.decoded.email };
  const user = await usersCollection.findOne(query);
  if (user.role !== "Buyer") {
    res.status(403).send({ message: "forbidden access" });
  }
  next();
};

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
  const user = await usersCollection.findOne({ email: req.params.email });
  res.send({ isSeller: user?.role === "Seller" });
});
//Check Buyer
app.get("/users/buyer/:email", async (req, res) => {
  const user = await usersCollection.findOne({ email: req.params.email });
  res.send({ isBuyer: user?.role === "Buyer" });
});

//Seller Verify Status
app.get("/users/verify/:email", async (req, res) => {
  const user = await usersCollection.findOne({ email: req.params.email });
  res.send({ isVerified: user?.verified === true });
});

app.get('/categories',async(req,res)=>{
  const result = await categoriesCollection.find({}).toArray()
  res.send(result)
})

app.get('/category/:id', async(req,res)=>{
  const id = req.params.id;
  const category = await categoriesCollection.findOne({_id: ObjectId(id)})
  const result = await productsCollection.find({category: category.Category}).toArray()
  res.send({result, category})
})

//Book items
app.post('/mybooking',verifyJWT,verifyBuyer, async(req,res)=>{
  const result = await bookingCollection.insertOne(req.body)
  res.send(result)
})
app.patch('/bookstatus/:id',verifyJWT,verifyBuyer,async(req,res)=>{
  const result = await productsCollection.updateOne({_id: ObjectId(req.params.id)},{
    $set: req.body
  })
  res.send(result)
})

//Report Items
app.put('/reported/:id',verifyJWT,async(req,res)=>{
  const filter = {productId: req.params.id}
  const options = {upsert: true}
  const updatedDoc = {
    $set: req.body
  }
  const result = await reportCollection.updateOne(filter, updatedDoc, options)
  res.send(result)
})

//Add and Delete Products
app.post("/addproduct", verifyJWT, verifySeller, async (req, res) => {
  const result = await productsCollection.insertOne(req.body);
  res.send(result);
});

app.delete("/myproducts/:id",verifyJWT,verifySeller, async (req, res) => {
  const result = await productsCollection.deleteOne({
    _id: ObjectId(req.params.id),
  });
  res.send(result);
});

//My Products
app.get("/myproducts/:email", verifyJWT,verifySeller, async (req, res) => {
  const result = await productsCollection
    .find({ email: req.params.email })
    .toArray();
  res.send(result);
});

//My Orders
app.get('/myorders/:email',verifyJWT,verifyBuyer,async(req,res)=>{
  const result = await bookingCollection.find({email: req.params.email}).toArray()
  res.send(result)
})

app.patch('/myorders/:id',verifyJWT,verifyBuyer,async(req,res)=>{
  const deleteOrder = await bookingCollection.deleteOne({productId: req.params.id})
  const result = await productsCollection.updateOne({_id: ObjectId(req.params.id)},{
    $set: req.body
  })
  res.send(result)
})

//Add,Remove and Get Advertisements
app.patch("/addAdv/:id", verifyJWT, verifySeller, async (req, res) => {
  try {
    const result = await productsCollection.updateOne({_id: ObjectId(req.params.id)},{
      $set: req.body
    })
    res.send(result)
  } catch (error) {console.log(error.message)}
});

app.patch("/rmvadvertise/:id", verifyJWT, verifySeller, async (req, res) => {
  try {
    const result = await productsCollection.updateOne({_id: ObjectId(req.params.id)},{
      $set: req.body
    })
    res.send(result)
  } catch (error) {console.log(error.message)}
});

app.get('/alladv', async(req,res)=>{
  const result = await productsCollection.find({status: "Advertised"}).toArray()
  res.send(result)
})

//Get Reported Items
app.get('/reporteditems',verifyJWT,verifyAdmin,async(req,res)=>{
  const result = await reportCollection.find({}).toArray()
  res.send(result)
})

//Get All Users
app.get('/allsellers',verifyJWT,verifyAdmin,async(req,res)=>{
  const result = await usersCollection.find({role: "Seller"}).toArray()
  res.send(result)
})
app.get('/allbuyers',verifyJWT,verifyAdmin,async(req,res)=>{
  const result = await usersCollection.find({role: "Buyer"}).toArray()
  res.send(result)
})

//verify User
app.patch("/verifyuser/:email",verifyJWT,verifyAdmin,async(req,res)=>{
  const updateVerify = await productsCollection.updateMany({email: req.params.email},{
    $set: {
      isVerified: true
    }
  })
  const result = await usersCollection.updateOne({email: req.params.email},{
    $set: req.body
  })
  res.send(result)
})

//Delete User
app.delete('/allusers/:id',verifyJWT,verifyAdmin,async(req,res)=>{
  const result = await usersCollection.deleteOne({_id: ObjectId(req.params.id)})
  res.send(result)
})

//Delete Report Item from inventory and report data
app.delete('/itemdelete/:id',verifyJWT,verifyAdmin,async(req,res)=>{
  const result = await productsCollection.deleteOne({_id: ObjectId(req.params.id)})
  res.send(result)
})
app.delete('/reportdelete/:id',verifyJWT,verifyAdmin,async(req,res)=>{
  const result = await reportCollection.deleteOne({_id: ObjectId(req.params.id)})
  res.send(result)
})

//Server Connection Status
app.get("/", (req, res) => {
  res.send("API is Running");
});

app.listen(port, () => console.log("Server is running through port: ", port));
