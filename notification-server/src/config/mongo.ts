import mongoose from "mongoose";
import { ENV } from "./env";

export const connectMongo = async () => {
    await mongoose.connect(ENV.mongoUrl);
    console.log("✅ MongoDB connected");
};