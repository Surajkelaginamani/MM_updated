require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  const conn = await mongoose.connect(process.env.MONGO_URI);
  const client = conn.connection.getClient();
  const localDb = client.db('local');
  const oplog = localDb.collection('oplog.rs');
  const ops = await oplog.find({
    ns: { $regex: '^Meal-Mitra\.' },
    op: { $in: ['d', 'u', 'i'] }
  }).sort({ ts: -1 }).limit(200).toArray();

  console.log(JSON.stringify(ops, null, 2));
  await conn.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
