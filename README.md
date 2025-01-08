# Gemini Transcribe

[https://gemini-transcribe.fly.dev/](https://gemini-transcribe.fly.dev/)

A web application for transcribing audio and video files using Google's Gemini Flash model.

Flash is a very interesting model to explore for audio transcription because:

- We can prompt for specific transcription outputs, as it processes both audio and text inputs
- It has built-in speaker diarization
- It can attempt to detect not only words but also silence, sentiment, and sounds beyond human voices
- It can translate the transcription, in particular to languages other than English

Google claims Flash's 1.5 word error rate is 9.6% in the FLEURS benchmark (September, 2024). This project is now using the experimental Flash 2.0, which does not appear to have been benchmarked yet.
