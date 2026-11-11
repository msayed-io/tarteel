# SADIE II D1 HRTF data

`sadie-ii-d1-48000.mhr` is the OpenAL Soft default HRTF data file copied unchanged from `hrtf/Default HRTF.mhr` at upstream revision `20b56ce9f5a1cc6ed8c41547e960e37e9f47bdd2`. SHA-256: `40ed10f203488fdeca5f873bfd64f6fae232f4f7412ba07ae5e501ad882adf8c`.

OpenAL Soft documents this default data as derived from the SADIE II database, subject D1 (KU100), and distributed under Apache License 2.0. The SADIE II measurements were developed by Cal Armstrong, Lewis Thresh, and Gavin Kearney at the Audio Lab, Department of Electronic Engineering, University of York, UK. The complete Apache 2.0 license is included in `LICENSE.Apache-2.0.txt`.

The embedded file is measured, directional HRIR data (48 kHz, 64-tap minimum-phase HRIRs with separately encoded propagation delays, 1,982 directions). It is a generic dummy-head reference, not personalized to an individual listener. It is parsed and processed locally; no runtime download or native codec dependency is used.

Sources: [OpenAL Soft](https://github.com/kcat/openal-soft), [OpenAL Soft HRTF documentation](https://raw.githubusercontent.com/kcat/openal-soft/master/docs/hrtf.txt), and the [SADIE II database](https://www.york.ac.uk/sadie-project/database.html).
