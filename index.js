const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios");
const cors = require("cors")({ origin: true });

admin.initializeApp();
const db = admin.firestore();

exports.apiGateway = functions.https.onRequest((request, response) => {
  cors(request, response, async () => {
    if (request.method !== "POST") return response.status(405).send("Method Not Allowed");

    // --- UPDATED PART ---
    // Now we get the provider from the request
    const { token, prompt, provider } = request.body;
    if (!token || !prompt || !provider) {
      return response.status(400).send("Missing token, prompt, or provider.");
    }

    try {
      const tokenRef = db.collection("access_tokens").doc(token);
      const tokenSnap = await tokenRef.get();

      if (!tokenSnap.exists) return response.status(403).send("Invalid access token.");

      const tokenData = tokenSnap.data();
      if (tokenData.isRevoked || new Date() > tokenData.expiresAt.toDate() || tokenData.requestsUsed >= tokenData.requestsLimit) {
        return response.status(403).send("Token is invalid, revoked, expired, or has reached its limit.");
      }
      if (tokenData.provider !== provider) {
          return response.status(403).send("Token-provider mismatch.");
      }

      const keyRef = db.collection("api_keys").doc(tokenData.apiKeyId);
      const keySnap = await keyRef.get();
      if (!keySnap.exists) return response.status(500).send("Internal error: API key not found.");

      const ownerApiKey = keySnap.data().keyValue;
      let aiMessage = "";

      // --- ROUTING LOGIC ---
      // This is where we choose which AI to call
      if (provider === "OpenAI") {
        const openAIResponse = await axios.post(
          "https://api.openai.com/v1/chat/completions",
          { model: "gpt-3.5-turbo", messages: [{ role: "user", content: prompt }] },
          { headers: { "Authorization": `Bearer ${ownerApiKey}` } }
        );
        aiMessage = openAIResponse.data.choices[0].message.content;
      } else if (provider === "Anthropic") {
        // NOTE: Anthropic's API structure is different!
        const anthropicResponse = await axios.post(
            "https://api.anthropic.com/v1/messages",
            {
                model: "claude-3-haiku-20240307",
                max_tokens: 1024,
                messages: [{ role: "user", content: prompt }]
            },
            {
                headers: {
                    "x-api-key": ownerApiKey,
                    "anthropic-version": "2023-06-01"
                }
            }
        );
        aiMessage = anthropicResponse.data.content[0].text;
      } else {
        return response.status(400).send("Unsupported provider.");
      }

      await tokenRef.update({ requestsUsed: admin.firestore.FieldValue.increment(1) });
      return response.status(200).send({ content: aiMessage });

    } catch (error) {
      console.error("Error in API Gateway:", error.response ? error.response.data : error.message);
      return response.status(500).send("An error occurred while processing your request.");
    }
  });
});
                            
