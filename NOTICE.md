# Third-party assets and services

The [MIT license](LICENSE) covers OpenMed application code and documentation. It does not replace the licenses of third-party data, models, fonts, or hosted APIs.

## BodyParts3D anatomy data

The layered GLB files and structure metadata in `static/assets/anatomy/` are derived from [BodyParts3D](https://lifesciencedb.jp/bp3d/), © The Database Center for Life Science, under [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/). The geometry has been simplified, reorganized into layers, and compressed. Attribution and a license link are also displayed in the anatomy viewer.

The conversion pipeline uses assets from [anatomy-lab](https://github.com/MrH0v0/anatomy-lab), which is MIT licensed. See its repository for its license and source pipeline.

An unused sample model previously stored in `static/models/` was removed because its noncommercial license did not match this project's intended open-source use.

## External services

OpenMed calls Cerebras and MediSearch using your own API keys. Their services, returned content, and usage terms are independent of this repository's MIT license.
