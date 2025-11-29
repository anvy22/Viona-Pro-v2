import { Kafka } from "kafkajs";
import { ENV } from "./env";

export const kafka = new Kafka({
    clientId:"notification-server",
    brokers: [ENV.kafkaBroker]
});