---
"react-isokit": patch
---

The sound switch now gates the whole chain: turning sound off fades out and stops every sounding instance and cancels the idle suspend timer, and nothing new is scheduled until it is turned back on. Turning it back on resumes the engine on the next play at the current volume, and `configureSound` volume changes reach the already-loaded graph as well as later plays.
