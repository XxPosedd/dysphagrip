# Safety, privacy, and claims

- This is a hackathon research prototype, not a medical device.
- Do not claim diagnosis or detection of dysphagia, aspiration, silent aspiration, pharyngeal residue, or safe swallowing.
- Do not recommend chin-tuck, repeat swallows, diet changes, or any clinical intervention.
- Do not induce choking, aspiration, coughing fits, or unsafe swallowing demonstrations.
- Use only consenting healthy volunteers and ordinary, comfortable activity.
- Keep the sensor mount non-compressive; do not wrap tightly around the neck or attach exposed circuit boards directly to skin.
- Obtain explicit consent before microphone use. Show a visible recording indicator and provide a stop control.
- Do not store raw audio by default. Avoid names and identifiable health information.
- If collecting any data beyond a local demo, document consent, purpose, retention, access, and deletion.
- A phone microphone near the neck captures ambient sound, not direct tissue vibration.
- The KORG CM-300 contact pickup senses surface vibration at its contact point. Its response to body-conducted sound is uncalibrated, and it is very sensitive to handling and cable noise.
- The audio service's "activity" flag means "energy above the noise floor". It is not a swallow detector.
- A motion sensor measures its own movement; it does not directly measure hyoid elevation or prove airway entry.
- Clinical aspiration assessment requires appropriate instrumental evaluation by qualified professionals.
- Neon stores derived session metrics and markers only: no raw audio, names or health information. Keep session
  labels and marker notes neutral (e.g. "bench test 3", "sip of water"). Sessions can be deleted from the dashboard.
