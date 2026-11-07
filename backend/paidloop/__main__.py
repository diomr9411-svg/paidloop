"""Start PaidLoop with: python -m paidloop"""

import uvicorn


def main() -> None:
    # 127.0.0.1 keeps the owner screens on this computer only.
    uvicorn.run("paidloop.main:app", host="127.0.0.1", port=8000)


if __name__ == "__main__":
    main()
