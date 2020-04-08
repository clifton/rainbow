import { get, keyBy, property, toLower, orderBy } from 'lodash';
import { compoundClient } from '../apollo/client';
import { COMPOUND_ACCOUNT_AND_MARKET_QUERY } from '../apollo/queries';
import { getSavings, saveSavings } from '../handlers/localstorage/accountLocal';
import assetTypes from '../helpers/assetTypes';
import { multiply } from '../helpers/utilities';
import { parseAssetName, parseAssetSymbol } from '../parsers/accounts';
import { CDAI_CONTRACT } from '../references';

// -- Constants --------------------------------------- //
const COMPOUND_QUERY_INTERVAL = 10000;
const SAVINGS_UPDATE_COMPOUND_DATA = 'savings/SAVINGS_UPDATE_COMPOUND_DATA';
const SAVINGS_UPDATE_COMPOUND_SUBSCRIPTION =
  'savings/SAVINGS_UPDATE_COMPOUND_SUBSCRIPTION';
const SAVINGS_CLEAR_STATE = 'savings/SAVINGS_CLEAR_STATE';

const getMarketData = (marketData, tokenOverrides) => {
  const underlying = getUnderlyingData(marketData, tokenOverrides);
  const cToken = getCTokenData(marketData, tokenOverrides);
  const { exchangeRate, supplyRate, underlyingPrice } = marketData;

  return {
    cToken,
    exchangeRate,
    supplyRate,
    underlying,
    underlyingPrice,
  };
};

const getCTokenData = (marketData, tokenOverrides) => {
  const { id: cTokenAddress, name, symbol } = marketData;

  return {
    address: cTokenAddress,
    decimals: 8,
    name: parseAssetName(name, cTokenAddress, tokenOverrides),
    symbol: parseAssetSymbol(symbol, cTokenAddress, tokenOverrides),
  };
};

const getUnderlyingData = (marketData, tokenOverrides) => {
  const {
    underlyingAddress,
    underlyingDecimals,
    underlyingName,
    underlyingSymbol,
  } = marketData;

  return {
    address: underlyingAddress,
    decimals: underlyingDecimals,
    name: parseAssetName(underlyingName, underlyingAddress, tokenOverrides),
    symbol: parseAssetSymbol(
      underlyingSymbol,
      underlyingAddress,
      tokenOverrides
    ),
  };
};

// -- Actions ---------------------------------------- //
export const savingsLoadState = () => async (dispatch, getState) => {
  try {
    subscribeToCompoundData(dispatch, getState);
    // eslint-disable-next-line no-empty
  } catch (error) {}
};

export const savingsClearState = () => (dispatch, getState) => {
  const { savingsSubscription } = getState().savings;
  savingsSubscription &&
    savingsSubscription.unsubscribe &&
    savingsSubscription.unsubscribe();
  dispatch({ type: SAVINGS_CLEAR_STATE });
};

const subscribeToCompoundData = async (dispatch, getState) => {
  const { accountAddress, network } = getState().settings;
  const { tokenOverrides } = getState().data;
  const { savingsSubscription } = getState().savings;

  if (savingsSubscription) {
    savingsSubscription.resetLastResults();
    savingsSubscription.refetch();
  } else {
    // First read from localstorage
    let savingsAccountLocal = accountAddress
      ? await getSavings(accountAddress, network)
      : [];

    const newSubscription = compoundClient
      .watchQuery({
        fetchPolicy: 'network-only',
        pollInterval: COMPOUND_QUERY_INTERVAL, // 15 seconds
        query: COMPOUND_ACCOUNT_AND_MARKET_QUERY,
        skip: !toLower(accountAddress),
        variables: { id: toLower(accountAddress) },
      })
      .subscribe({
        next: async ({ data }) => {
          let savingsAccountData = [];
          const markets = keyBy(get(data, 'markets', []), property('id'));

          let accountTokens = get(data, 'account.tokens', []);

          accountTokens = accountTokens.map(token => {
            const [cTokenAddress] = token.id.split('-');
            const marketData = markets[cTokenAddress] || {};

            const {
              cToken,
              exchangeRate,
              supplyRate,
              underlying,
              underlyingPrice,
            } = getMarketData(marketData, tokenOverrides);

            const ethPrice = multiply(
              underlyingPrice,
              token.supplyBalanceUnderlying
            );

            const {
              cTokenBalance,
              lifetimeSupplyInterestAccrued,
              supplyBalanceUnderlying,
            } = token;

            return {
              cToken,
              cTokenBalance,
              ethPrice,
              exchangeRate,
              lifetimeSupplyInterestAccrued,
              supplyBalanceUnderlying,
              supplyRate,
              type: assetTypes.cToken,
              underlying,
              underlyingPrice,
            };
          });

          accountTokens = orderBy(accountTokens, ['ethPrice'], ['desc']);

          if (accountTokens.length) {
            saveSavings(accountTokens, accountAddress, network);
            savingsAccountData = accountTokens;
          } else {
            savingsAccountData = savingsAccountLocal;
          }

          const daiMarketData = getMarketData(
            markets[CDAI_CONTRACT],
            tokenOverrides
          );

          dispatch({
            payload: {
              accountTokens: savingsAccountData,
              daiMarketData: daiMarketData,
            },
            type: SAVINGS_UPDATE_COMPOUND_DATA,
          });
        },
      });
    dispatch({
      payload: newSubscription,
      type: SAVINGS_UPDATE_COMPOUND_SUBSCRIPTION,
    });
  }
};

// -- Reducer ----------------------------------------- //
const INITIAL_STATE = {
  accountTokens: [],
  daiMarketData: {},
  savingsSubscription: null,
};

export default (state = INITIAL_STATE, action) => {
  switch (action.type) {
    case SAVINGS_UPDATE_COMPOUND_SUBSCRIPTION:
      return { ...state, savingsSubscription: action.payload };
    case SAVINGS_UPDATE_COMPOUND_DATA:
      return {
        ...state,
        accountTokens: action.payload.accountTokens,
        daiMarketData: action.payload.daiMarketData,
      };
    case SAVINGS_CLEAR_STATE:
      return {
        ...state,
        ...INITIAL_STATE,
      };
    default:
      return state;
  }
};
