const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios");
const cors = require("cors")({ origin: true });

admin.initializeApp();
const db = admin.firestore();

exports.apiGateway = functions.https.onRequest((request, response) => {
  cors(request, response, async () => {
    // --- 1. Check for valid input ---
    if (request.method !== "POST") {
      return response.status(405).send("Method Not Allowed");
    }
    const { token, prompt } = request.body;
    if (!token || !prompt) {
      return response.status(400).send("Missing token or prompt.");
    }

    try {
      // --- 2. Validate the Access Token ---
      const tokenRef = db.collection("access_tokens").doc(token);
      const tokenSnap = await tokenRef.get();

      if (!tokenSnap.exists) {
        return response.status(403).send("Invalid access token.");
      }

      const tokenData = tokenSnap.data();
      const now = new Date();

      if (tokenData.isRevoked) {
        return response.status(403).send("This link has been revoked.");
      }
      if (now > tokenData.expiresAt.toDate()) {
        return response.status(403).send("This link has expired.");
      }
      if (tokenData.requestsUsed >= tokenData.requestsLimit) {
        return response.status(403).send("Request limit reached.");
      }

      // --- 3. Get the Owner's API Key ---
      const keyRef = db.collection("api_keys").doc(tokenData.apiKeyId);
      const keySnap = await keyRef.get();
      if (!keySnap.exists) {
        return response.status(500).send("Internal server error: API key not found.");
      }
      const ownerApiKey = keySnap.data().keyValue;

      // --- 4. Call the OpenAI API ---
      const openAIResponse = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-3.5-turbo",
          messages: [{ role: "user", content: prompt }],
        },
        {
          headers: {
            "Authorization": `Bearer ${ownerApiKey}`,
            "Content-Type": "application/json",
          },
        }
      );

      const aiMessage = openAIResponse.data.choices[0].message.content;

      // --- 5. Update the Usage Count ---
      await tokenRef.update({
        requestsUsed: admin.firestore.FieldValue.increment(1),
      });

      // --- 6. Send Response to the User ---
      return response.status(200).send({ content: aiMessage });

    } catch (error) {
      console.error("Error in API Gateway:", error);
      if (error.response && error.response.data) {
        console.error("OpenAI Error:", error.response.data);
      }
      return response.status(500).send("An error occurred while processing your request.");
    }
  });
});

